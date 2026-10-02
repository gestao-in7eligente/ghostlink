// Attachments in main (spec 2026-10-01-anexos §2, §4): uploads to the server on screen with
// progress, the app://ghostlink/_file route with its image cache, and "Baixar", wired together
// for index.ts.
import { join } from 'node:path';
import { AppError } from '../../shared/appErrors.js';
import type { UploadProgressEvent } from '../../shared/attachmentTypes.js';
import type { ActiveSession } from '../controller.js';
import { openFile, uploadAttachment, type AttachmentHttpOptions } from './attachmentHttp.js';
import type { AttachmentsIpcDeps } from './attachmentsIpc.js';
import { saveAttachment, type SaveDeps } from './download.js';
import { FileCache } from './fileCache.js';
import { FileRoute } from './fileRoute.js';

/** Progress reaches the page at most this often per upload (and always at the end). */
export const PROGRESS_INTERVAL_MS = 100;

export interface Attachments {
  /** IpcDeps.attachments. */
  ipc: AttachmentsIpcDeps;
  /** The app:// handler's `_file` route. */
  route(request: Request): Promise<Response>;
  /** ControllerDeps.onSession: the session on screen. */
  onSession(session: ActiveSession | null): void;
}

export interface AttachmentsOptions {
  userDataDir: string;
  /** Upload progress to the page (IPC_EVENTS.attachmentProgress). */
  emitProgress(event: UploadProgressEvent): void;
  /** For "Baixar": the whole app:// handler and the save dialog. */
  save: SaveDeps;
  warn(message: string): void;
  /** Tests shorten the idle timeout. */
  http?: AttachmentHttpOptions;
  cacheMaxBytes?: number;
  now?: () => number;
}

export function createAttachments(opts: AttachmentsOptions): Attachments {
  const now = opts.now ?? Date.now;
  const cache = FileCache.open(join(opts.userDataDir, 'attachments'), { maxBytes: opts.cacheMaxBytes });
  let session: ActiveSession | null = null;
  const route = new FileRoute({
    session: () => session,
    cache,
    open: (s, fileId, req) => openFile(s, fileId, req, opts.http),
    warn: opts.warn,
  });
  return {
    ipc: {
      upload: async (uploadId, serverId, channelId, name, bytes) => {
        // Only to the server on screen: a channel id means nothing anywhere else.
        const target = session;
        if (target === null || target.serverId !== serverId) throw new AppError('CONNECTION_LOST', 'not connected to that server');
        let last = 0;
        const fileId = await uploadAttachment(
          target,
          {
            channelId,
            name,
            bytes,
            onProgress: (sent, total) => {
              const at = now();
              if (sent < total && at - last < PROGRESS_INTERVAL_MS) return;
              last = at;
              opts.emitProgress({ uploadId, sent, total });
            },
          },
          opts.http,
        );
        return { fileId };
      },
      save: (src, name) => saveAttachment(opts.save, src, name),
    },
    route: (request) => route.handle(request),
    onSession: (s) => {
      session = s;
    },
  };
}
