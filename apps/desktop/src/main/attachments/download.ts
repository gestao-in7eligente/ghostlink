// "Baixar" (spec 2026-10-01-anexos §1): always asks where to save with the system dialog, then
// writes the file there through the same app:// route the page loads it from (servers' _file, the
// DM engine's _dmfile). The app never opens the saved file. The renderer only gets the file name.
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { cleanFileName } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { DM_FILE_URL_PREFIX, SERVER_FILE_URL_PREFIX, type SaveResult } from '../../shared/attachmentTypes.js';

export interface SaveDeps {
  /** The app:// handler (appProtocol.createAppRequestHandler): the attachment routes answer it. */
  fetch(request: Request): Response | Promise<Response>;
  /** The system's save dialog, starting at `suggestedName`; null when the person cancels. */
  choosePath(suggestedName: string): Promise<string | null>;
}

/** A save in progress, next to where it lands: renamed over the chosen path only once complete. */
function partPath(path: string): string {
  return `${path}.ghostlink-${process.pid}.part`;
}

export async function saveAttachment(deps: SaveDeps, src: string, name: string): Promise<SaveResult> {
  if (!src.startsWith(SERVER_FILE_URL_PREFIX) && !src.startsWith(DM_FILE_URL_PREFIX)) throw new AppError('BAD_REQUEST', 'not an attachment');
  const path = await deps.choosePath(cleanFileName(name));
  if (path === null) return { saved: false, fileName: null };
  const res = await deps.fetch(new Request(src));
  if (!res.ok || res.body === null) {
    await res.body?.cancel().catch(() => undefined);
    throw new AppError('NOT_FOUND', 'the attachment is not available');
  }
  const part = partPath(path);
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(part, { flags: 'w' }));
    renameSync(part, path);
  } catch (e) {
    rmSync(part, { force: true });
    if (e instanceof AppError) throw e;
    // A full disk or a folder without permission comes back as Node's error: never its message (it has the path).
    throw new AppError((e as { code?: unknown }).code === 'ECONNRESET' ? 'CONNECTION_LOST' : 'INTERNAL', 'the file could not be saved');
  }
  return { saved: true, fileName: basename(path) };
}
