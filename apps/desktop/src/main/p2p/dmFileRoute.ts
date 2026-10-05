// app://ghostlink/_dmfile/<hash> (attachments spec §4): how the renderer shows a direct
// message's file. Only a file that some message carries and that is here whole (it reached
// friends/files only after its hash matched) is served; anything else is a 404. The type comes
// from the bytes again, never from what the sender wrote: images, video and audio show inline,
// everything else only downloads (Content-Disposition: attachment). Video and audio seek with
// Range requests. The renderer never learns a path.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { ATTACHMENT_LIMITS, fileInfo } from '@ghostlink/shared';
import { FILE_HASH } from './dmFiles.js';

export const DM_FILE_PREFIX = '/_dmfile/';

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
  // Opened on its own (never by the app), nothing in it may run.
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;

/** The hash of an app://ghostlink/_dmfile/<hash> URL, or null. */
export function dmFileHash(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'app:' || parsed.host !== 'ghostlink' || !parsed.pathname.startsWith(DM_FILE_PREFIX)) return null;
  const hash = parsed.pathname.slice(DM_FILE_PREFIX.length);
  return FILE_HASH.test(hash) ? hash : null;
}

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const n = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** One `bytes=a-b` range of a file of `size` bytes; null for none, 'bad' for one that cannot be served. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'bad' {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (match[1] === '') {
    // The last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

/** The route, given how to find a file: the engine's dmFile (null when no message here carries it). */
export function createDmFileRoute(locate: (hash: string) => string | null): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: BASE_HEADERS });
    const hash = dmFileHash(request.url);
    const path = hash === null ? null : locate(hash);
    let size: number;
    try {
      if (path === null) throw new Error('not here');
      size = statSync(path).size;
    } catch {
      return new Response(null, { status: 404, headers: BASE_HEADERS });
    }
    const info = fileInfo(readRange(path!, 0, Math.min(size, ATTACHMENT_LIMITS.sniffBytes)));
    const inline = info.kind !== 'file';
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Accept-Ranges': 'bytes',
      'Content-Type': inline ? info.mime : 'application/octet-stream',
      ...(inline ? {} : { 'Content-Disposition': 'attachment' }),
    };
    const range = parseRange(request.headers.get('Range'), size);
    if (range === 'bad') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = end - start + 1;
    const body = request.method === 'HEAD' || size === 0 ? null : new Uint8Array(readRange(path!, start, length));
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, 'Content-Length': String(length), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
    });
  };
}
