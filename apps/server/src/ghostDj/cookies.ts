import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtocolError, ghostDjCookiesProblem, type GhostDjCookiesView } from '@ghostlink/shared';
import { COOKIES_FILE } from './ytdlp.js';

// The owner's YouTube cookies (spec 2026-10-02-sons-da-chamada-e-cookies-do-dj §2, v0.5.2), sent
// from the Ghost DJ's page and kept as `<data>/ghost-dj/cookies.txt`, where yt-dlp reads them at
// each run (the next /play uses them, no restart). Their content never leaves the file: not in an
// answer, an error message or the log.

/** yt-dlp (Python's MozillaCookieJar) refuses a file whose first line does not say this. */
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HEADER = /#( Netscape)? HTTP Cookie File/;

/** When the cookies were sent (the file's time), or null without them. */
export function cookiesView(dir: string): GhostDjCookiesView | null {
  try {
    return { setAt: Math.floor(statSync(join(dir, COOKIES_FILE)).mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * Checks a cookies file (ghostDjCookiesProblem) and puts it in place at once, readable by the
 * server's user only: yt-dlp sees the old file or the new one, never half of it. Lines end in
 * LF, and the Netscape header goes first when the file came without it. Throws FILE_TOO_LARGE or
 * BAD_REQUEST (with a fixed message) for a file that is refused.
 */
export function saveCookies(dir: string, content: string): void {
  const problem = ghostDjCookiesProblem(content);
  if (problem === 'too_large') throw new ProtocolError('FILE_TOO_LARGE');
  if (problem === 'format') throw new ProtocolError('BAD_REQUEST', 'not a Netscape cookies file');
  if (problem === 'no_youtube') throw new ProtocolError('BAD_REQUEST', 'no youtube.com cookie');
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (!HEADER.test(lines[0] ?? '')) lines.unshift(NETSCAPE_HEADER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staged = join(dir, `${COOKIES_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(staged, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(staged, join(dir, COOKIES_FILE));
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Removes the cookies file (nothing when there is none). */
export function clearCookies(dir: string): void {
  rmSync(join(dir, COOKIES_FILE), { force: true });
}
