// app://ghostlink/_file/<serverId>/<fileId> (spec 2026-10-01-anexos §4): the only way the renderer
// loads a server attachment. Main fetches it from the server on screen with the signed URL and the
// pin, passes Range through (video seeking), and keeps images in a disk cache. The renderer never
// learns a path, a URL or the fileToken. Anything else (another server, no session, a refusal) is
// a 404, and the page shows "Arquivo indisponível".
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { IncomingHttpHeaders } from 'node:http';
import { entityIdSchema, imageInfo } from '@ghostlink/shared';
import { toAppErrorCode } from '../../shared/appErrors.js';
import type { PinnedStreamResponse } from '../pinnedHttp.js';
import { takesAttachments, type FileServer } from './attachmentHttp.js';
import { FILE_CACHE_MAX_ENTRY_BYTES, fileCacheKey, type FileCache } from './fileCache.js';

export const FILE_ROUTE_HOST = 'ghostlink';
/** Every path under it belongs to this route: it never falls back to the app's index.html. */
export const FILE_ROUTE_PREFIX = '/_file';

/** Served with their own type: what the page shows inline (the four kinds of spec §1 that play or show). */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
]);

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
  // Never a document: nothing served here may run or frame anything, even if it were navigated to.
  'Content-Security-Policy': "sandbox; default-src 'none'",
} as const;

/** The live session, as fileRoute needs it. */
export type FileSession = FileServer & { serverId: string; serverKeyId: string };

export interface FileRouteDeps {
  /** The session on screen, or null. */
  session(): FileSession | null;
  cache: Pick<FileCache, 'get' | 'put'>;
  open(session: FileSession, fileId: string, req: { method: 'GET' | 'HEAD'; range: string | null }): Promise<PinnedStreamResponse>;
  warn(message: string): void;
}

/** True for app://ghostlink/_file and anything under it. */
export function isFileRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  return parsed.protocol === 'app:' && parsed.host === FILE_ROUTE_HOST && (path === FILE_ROUTE_PREFIX || path.startsWith(`${FILE_ROUTE_PREFIX}/`));
}

/** The server and file a route URL names, or null. */
export function parseFileUrl(url: string): { serverId: string; fileId: string } | null {
  if (!isFileRequest(url)) return null;
  const parts = new URL(url).pathname.slice(FILE_ROUTE_PREFIX.length + 1).split('/');
  if (parts.length !== 2) return null;
  let serverId: string;
  try {
    serverId = decodeURIComponent(parts[0]!);
  } catch {
    return null;
  }
  const fileId = parts[1]!;
  if (serverId.length < 1 || serverId.length > 64 || !entityIdSchema.safeParse(fileId).success) return null;
  return { serverId, fileId };
}

/** The type the page may see: the server's when it is one of the inline types, else a download. */
export function servedType(serverType: string | undefined): { type: string; inline: boolean } {
  const type = (serverType ?? '').split(';')[0]!.trim().toLowerCase();
  return INLINE_TYPES.has(type) ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

function headersFor(type: { type: string; inline: boolean }, from: IncomingHttpHeaders | null, length: number | null): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': type.type, 'Accept-Ranges': 'bytes' };
  if (!type.inline) headers['Content-Disposition'] = 'attachment';
  if (length !== null) headers['Content-Length'] = String(length);
  else if (typeof from?.['content-length'] === 'string') headers['Content-Length'] = from['content-length'];
  if (typeof from?.['content-range'] === 'string') headers['Content-Range'] = from['content-range'];
  return headers;
}

/** A whole file held in memory: from the cache, or just read to be kept. */
interface Whole {
  bytes: Buffer;
  mime: string;
}

const notFound = () => new Response(null, { status: 404, headers: BASE_HEADERS });

/** Reads a whole body of a known, bounded length; null when it is longer or breaks off. */
function readAll(res: PinnedStreamResponse, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.body.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        res.body.destroy();
        resolve(null);
      } else chunks.push(chunk);
    });
    res.body.on('end', () => resolve(Buffer.concat(chunks, size)));
    res.body.on('error', () => resolve(null));
  });
}

export class FileRoute {
  readonly #deps: FileRouteDeps;
  /** Whole-image downloads on their way, so several <img> of one file make one request. */
  readonly #inflight = new Map<string, Promise<Whole | null>>();

  constructor(deps: FileRouteDeps) {
    this.#deps = deps;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: BASE_HEADERS });
    const target = parseFileUrl(request.url);
    const session = this.#deps.session();
    if (target === null || session === null || session.serverId !== target.serverId || !takesAttachments(session)) return notFound();
    const key = fileCacheKey(session.serverKeyId, target.fileId);
    const range = request.headers.get('range');
    const head = request.method === 'HEAD';
    if (range !== null) return this.#fetch(session, target.fileId, key, { head, range, whole: null });

    const cached = this.#deps.cache.get(key);
    if (cached !== null) return this.#whole({ bytes: cached.bytes, mime: cached.info.mime }, head);
    const running = this.#inflight.get(key);
    if (running) {
      const known = await running;
      if (known !== null) return this.#whole(known, head);
      return this.#fetch(session, target.fileId, key, { head, range: null, whole: null });
    }
    // The first plain request of a file: whoever asks meanwhile waits for it (null: not an image to keep).
    let settle!: (whole: Whole | null) => void;
    const whole = new Promise<Whole | null>((resolve) => (settle = resolve));
    this.#inflight.set(key, whole);
    try {
      return await this.#fetch(session, target.fileId, key, { head, range: null, whole: settle });
    } finally {
      settle(null); // no-op once settled
      this.#inflight.delete(key);
    }
  }

  async #fetch(session: FileSession, fileId: string, key: string, req: { head: boolean; range: string | null; whole: ((w: Whole | null) => void) | null }): Promise<Response> {
    let res: PinnedStreamResponse;
    try {
      res = await this.#deps.open(session, fileId, { method: req.head ? 'HEAD' : 'GET', range: req.range });
    } catch (e) {
      const code = toAppErrorCode(e);
      if (code !== 'NOT_FOUND' && code !== 'FORBIDDEN') this.#deps.warn(`[attachments] download failed: ${code}`);
      return notFound();
    }
    const type = servedType(typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined);
    if (res.status === 416) {
      res.body.destroy();
      return new Response(null, { status: 416, headers: headersFor(type, res.headers, 0) });
    }
    if (req.head) {
      res.body.destroy();
      return new Response(null, { status: res.status, headers: headersFor(type, res.headers, null) });
    }

    // A whole image of a known, modest size: read it once, keep it, serve it.
    const length = Number(res.headers['content-length']);
    if (res.status === 200 && req.range === null && type.type.startsWith('image/') && Number.isFinite(length) && length > 0 && length <= FILE_CACHE_MAX_ENTRY_BYTES) {
      const image = await this.#keep(key, res, length);
      req.whole?.(image);
      return image === null ? notFound() : this.#whole(image, false);
    }

    req.whole?.(null);
    const body = Readable.toWeb(res.body) as WebReadableStream<Uint8Array>;
    return new Response(body as unknown as ReadableStream<Uint8Array>, { status: res.status, headers: headersFor(type, res.headers, null) });
  }

  /** The whole image, typed from its own bytes (a file that is no image is served as a download, never kept). */
  async #keep(key: string, res: PinnedStreamResponse, length: number): Promise<Whole | null> {
    const bytes = await readAll(res, length);
    if (bytes === null || bytes.byteLength !== length) return null;
    const info = imageInfo(bytes);
    if (info === null) return { bytes, mime: 'application/octet-stream' };
    try {
      this.#deps.cache.put(key, bytes);
    } catch (e) {
      this.#deps.warn(`[attachments] could not keep an image: ${toAppErrorCode(e)}`); // still served this time
    }
    return { bytes, mime: info.mime };
  }

  #whole(file: Whole, head: boolean): Response {
    const type = servedType(file.mime);
    return new Response(head ? null : new Uint8Array(file.bytes), { status: 200, headers: headersFor(type, null, file.bytes.byteLength) });
  }
}
