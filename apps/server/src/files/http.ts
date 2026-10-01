import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanFileName, fileTarget, type AttachmentKind } from '@ghostlink/shared';
import type { Logger } from '../logger.js';
import { CORS, errnoOf, fail, preflight, queryOf, reply } from '../uploads/http.js';
import { verifySignedQuery } from '../uploads/signedUrl.js';

export const FILES_PREFIX = '/files/';

/** File ids: 128 random bits in base32 (main spec §5.3). */
const FILE_ID = /^[A-Z2-7]{26}$/;

export interface FileRow {
  id: string;
  uploader_id: string;
  message_id: number | null;
  channel_id: string | null;
  name: string;
  size: number;
  kind: AttachmentKind;
  mime: string;
  disk_name: string;
}

/** What `GET /files/<fileId>` needs from the module. */
export interface FileHttpDeps {
  now(): number;
  logger: Logger;
  /** See SessionsApi.fileToken: non-null only for a current session. */
  fileToken(sessionId: string): string | null;
  /** The member behind a current session, or null. */
  userOf(sessionId: string): string | null;
  file(fileId: string): FileRow | undefined;
  /** VIEW_CHANNEL now, private-channel rules included; false for a former member. */
  canView(userId: string, channelId: string): boolean;
  path(diskName: string): string;
}

type Range = { start: number; end: number };

/**
 * One `bytes=` range of a file of `size` bytes. null: no usable Range (none, several, or
 * malformed), so the whole file goes; 'unsatisfiable': it starts past the end (416).
 */
export function parseRange(header: string | undefined, size: number): Range | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[2] !== '' && last < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(last, size - 1) };
}

/** RFC 6266/8187: the name in UTF-8, percent-encoded; only images, video and audio show inline. */
export function contentDisposition(kind: AttachmentKind, name: string): string {
  const encoded = encodeURIComponent(cleanFileName(name)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`;
}

/**
 * `GET /files/<fileId>?sid=…&e=…&s=…` (main spec §7, target = the fileId; spec 2026-10-01-anexos
 * §2). The session's member must see the file's channel at this moment; an upload no message
 * used yet is its uploader's alone. 403 for a bad, expired or foreign signature; 404 for
 * anything the member may not see, exactly like a missing file. `Range` (one range),
 * `nosniff`, and `Content-Disposition: attachment` for whatever is not an image, video or audio.
 */
export function serveFile(deps: FileHttpDeps, req: IncomingMessage, res: ServerResponse, fileId: string): void {
  if (req.method === 'OPTIONS') return preflight(res, 'GET, HEAD, OPTIONS');
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, null, { Allow: 'GET, HEAD, OPTIONS' });
  if (!FILE_ID.test(fileId)) return fail(res, 'NOT_FOUND');
  const sid = verifySignedQuery(queryOf(req.url), fileTarget(fileId), deps.now(), (s) => deps.fileToken(s));
  const userId = sid === null ? null : deps.userOf(sid);
  if (userId === null) return fail(res, 'FORBIDDEN');
  const row = deps.file(fileId);
  if (!row || row.channel_id === null || (row.message_id === null && row.uploader_id !== userId) || !deps.canView(userId, row.channel_id)) {
    return fail(res, 'NOT_FOUND');
  }
  const path = deps.path(row.disk_name);
  stat(path).then(
    (st) => {
      if (res.headersSent || res.destroyed) return;
      const size = st.size;
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
      const headers = {
        ...CORS,
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Content-Type': row.mime,
        'Content-Disposition': contentDisposition(row.kind, row.name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=600',
        'Accept-Ranges': 'bytes',
      };
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
        return res.end();
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      const length = size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, {
        ...headers,
        'Content-Length': String(length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (req.method === 'HEAD' || length === 0) return res.end();
      const stream = createReadStream(path, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    },
    (e: unknown) => {
      if (errnoOf(e) === 'ENOENT') return fail(res, 'NOT_FOUND'); // deleted meanwhile
      deps.logger.error('an attachment could not be read', { error: errnoOf(e) });
      fail(res, 'INTERNAL');
    },
  );
}
