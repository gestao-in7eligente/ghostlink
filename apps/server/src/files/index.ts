import { join } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  FEATURE_ATTACHMENTS,
  MB,
  PERMISSIONS,
  ProtocolError,
  cleanFileName,
  fileInfo,
  has,
  isImageTooLarge,
  type AttachmentUploadResult,
  type ErrorCode,
} from '@ghostlink/shared';
import { AVATARS_MODULE_NAME, type AvatarsModule } from '../avatars/index.js';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { storageUsedBytes } from '../text/handlers/server.js';
import { TEXT_MODULE_NAME, getVoiceAccess, type TextModule, type VoiceAccess } from '../text/index.js';
import { newEntityId } from '../text/repo.js';
import { discardStaged, type UploadAnswer, type UploadPurposeHandler } from '../uploads/hub.js';
import { pathOf } from '../uploads/http.js';
import type { UploadGrant } from '../uploads/tokens.js';
import { FILES_PREFIX, serveFile, type FileHttpDeps, type FileRow } from './http.js';
import { FileStore } from './store.js';

export const FILES_MODULE_NAME = 'files';

export interface FilesModule extends ServerModule {
  readonly name: typeof FILES_MODULE_NAME;
  /**
   * The clean-up, also run every minute: uploads no message used within 1 h go, then every
   * stored file no row references (deleted messages and channels). Synchronous.
   */
  sweep(): void;
}

const SWEEP_INTERVAL_MS = 60_000;
const BEGINS_WINDOW_MS = 60_000;

/** The bits an attachment needs in its channel (spec 2026-10-01-anexos §2). */
const NEEDED = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES;

interface State {
  ctx: ModuleContext;
  store: FileStore;
  access: VoiceAccess;
  begins: SlidingWindowLimiter;
  http: FileHttpDeps;
}

/**
 * Attachments in channels (spec 2026-10-01-anexos-design.md §2; main spec §7): the
 * `attachments` flag, the `attachment` purpose of upload.begin + POST /upload (through the
 * avatars module's upload hub), the signed `GET /files/<fileId>` and the clean-up. The text
 * module links files to messages (msg.send), shows them (Message.attachments) and deletes
 * their rows with the message; this module keeps the bytes. Register it after the text and
 * avatars modules. URLs, tokens, names and bytes never reach the log.
 */
export function createFilesModule(): FilesModule {
  let state: State | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  const unsubscribe: Array<() => void> = [];

  const need = (): State => {
    if (!state) throw new Error('the files module is not initialized');
    return state;
  };

  /** Deletes every stored file no row references. */
  const cleanBytes = (s: State): void => {
    const keep = new Set(s.ctx.db.all<{ d: string }>('SELECT disk_name AS d FROM files').map((r) => r.d));
    let failed: number;
    try {
      failed = s.store.sweep(keep);
    } catch {
      failed = 1;
    }
    if (failed > 0) s.ctx.logger.warn('some deleted attachments could not be removed from the disk yet', { failed });
  };

  const sweep = (s: State): void => {
    s.ctx.db.run('DELETE FROM files WHERE message_id IS NULL AND created_at < ?', s.ctx.now() - ATTACHMENT_LIMITS.unusedTtlMs);
    cleanBytes(s);
  };

  /** At start: half-written uploads go, a row whose bytes are gone is forgotten, and bytes with no row go. */
  const reconcile = (s: State): void => {
    s.store.open();
    const stored = s.store.names();
    const lost = s.ctx.db.all<{ id: string; d: string }>('SELECT id, disk_name AS d FROM files').filter((r) => !stored.has(r.d));
    for (const r of lost) s.ctx.db.run('DELETE FROM files WHERE id = ?', r.id);
    if (lost.length > 0) s.ctx.logger.warn('some attachments were missing from the disk and were forgotten', { count: lost.length });
    sweep(s);
  };

  /** Why a file of `size` bytes cannot be stored now, or null (spec §2: FILE_TOO_LARGE, QUOTA_EXCEEDED). */
  const refusal = (s: State, size: number): ErrorCode | null => {
    const meta = getMeta(s.ctx.db);
    if (size > meta.uploadLimitMb * MB) return 'FILE_TOO_LARGE';
    if (storageUsedBytes(s.ctx) + size > meta.storageQuotaMb * MB) return 'QUOTA_EXCEEDED';
    return null;
  };

  /** The member may still attach to that text channel (read fresh: a role or the channel may have changed). */
  const mayAttach = (s: State, userId: string, channelId: string): boolean => {
    const channel = s.access.channel(channelId);
    return channel?.type === 'text' && (s.access.permissions(userId, channelId) & NEEDED) === NEEDED;
  };

  const purpose = (s: State): UploadPurposeHandler => {
    const canApply = (grant: UploadGrant) => grant.attachment !== undefined && mayAttach(s, grant.userId, grant.attachment.channelId);
    return {
      stagingDir: s.store.dir,
      // The server's own limit is checked in begin and finish, so a lowered one answers FILE_TOO_LARGE.
      maxBytes: () => ATTACHMENT_LIMITS.uploadLimitMb.max * MB,

      begin(ctx, p) {
        if (p.purpose !== 'attachment') throw new ProtocolError('BAD_REQUEST');
        const channel = s.access.channel(p.channelId);
        const bits = channel ? s.access.permissions(ctx.userId, p.channelId) : 0;
        // A channel the member cannot see answers like a missing one (main spec §5.3).
        if (!channel || !has(bits, PERMISSIONS.VIEW_CHANNEL)) throw new ProtocolError('NOT_FOUND');
        if (channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'voice channels have no messages');
        if (!has(bits, PERMISSIONS.SEND_MESSAGES) || !has(bits, PERMISSIONS.ATTACH_FILES)) throw new ProtocolError('FORBIDDEN');
        const refused = refusal(s, p.size);
        if (refused) throw new ProtocolError(refused);
        if (!s.begins.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
        const fileId = newEntityId();
        return { attachment: { channelId: p.channelId, name: cleanFileName(p.name), fileId }, answer: { fileId } };
      },

      canApply,

      // Synchronous from the checks to the row, so the quota holds however many uploads end together.
      finish(grant, body): UploadAnswer {
        const refuse = (code: ErrorCode): UploadAnswer => {
          discardStaged(body.staged);
          return { ok: false, code };
        };
        const a = grant.attachment;
        if (!a || !canApply(grant)) return refuse('FORBIDDEN');
        const info = fileInfo(body.head);
        if (info.kind === 'image' && isImageTooLarge(info)) return refuse('IMAGE_TOO_LARGE');
        const refused = refusal(s, grant.size);
        if (refused) return refuse(refused);
        const diskName = s.store.commit(body.staged);
        try {
          s.ctx.db.run(
            `INSERT INTO files (id, uploader_id, purpose, channel_id, name, size, kind, mime, width, height, disk_name, created_at)
             VALUES (?, ?, 'attachment', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.fileId, grant.userId, a.channelId, a.name, grant.size, info.kind, info.mime,
            info.width ?? null, info.height ?? null, diskName, s.ctx.now(),
          );
        } catch (e) {
          s.store.remove(diskName);
          throw e;
        }
        const result: AttachmentUploadResult = { fileId: a.fileId };
        return { ok: true, body: result };
      },
    };
  };

  return {
    name: FILES_MODULE_NAME,
    features: [FEATURE_ATTACHMENTS],

    sweep: () => sweep(need()),

    init(ctx) {
      const text = ctx.getModule<TextModule>(TEXT_MODULE_NAME);
      const uploads = ctx.getModule<AvatarsModule>(AVATARS_MODULE_NAME).uploads;
      const access = getVoiceAccess(ctx);
      const store = new FileStore(join(ctx.dataDir, 'files'));
      const s: State = {
        ctx,
        store,
        access,
        begins: new SlidingWindowLimiter(ATTACHMENT_LIMITS.beginsPerMinute, BEGINS_WINDOW_MS, ctx.now),
        http: {
          now: ctx.now,
          logger: ctx.logger,
          fileToken: (sessionId) => ctx.sessions.fileToken(sessionId),
          userOf: (sessionId) => ctx.sessions.list().find((x) => x.sessionId === sessionId)?.userId ?? null,
          file: (fileId) =>
            ctx.db.get<FileRow>('SELECT id, uploader_id, message_id, channel_id, name, size, kind, mime, disk_name FROM files WHERE id = ?', fileId),
          canView: (userId, channelId) => has(access.permissions(userId, channelId), PERMISSIONS.VIEW_CHANNEL),
          path: (diskName) => store.path(diskName),
        },
      };
      reconcile(s);
      uploads.register('attachment', purpose(s));
      // The rows went with the message or the channel (text module); the bytes go now.
      unsubscribe.push(text.events.on('messages.deleted', () => cleanBytes(s)));
      unsubscribe.push(text.events.on('channel.deleted', () => cleanBytes(s)));
      state = s;
      sweepTimer = setInterval(() => {
        s.begins.sweep();
        try {
          sweep(s);
        } catch (e) {
          ctx.logger.error('the attachments clean-up failed', { error: String((e as { code?: unknown } | null)?.code ?? 'unknown') });
        }
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref();
    },

    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const off of unsubscribe.splice(0)) off();
    },

    http(req, res) {
      const path = pathOf(req.url);
      if (!path.startsWith(FILES_PREFIX)) return false;
      serveFile(need().http, req, res, path.slice(FILES_PREFIX.length));
      return true;
    },
  };
}
