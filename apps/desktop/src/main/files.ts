import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { z } from 'zod';

/** Local time as yyyyMMdd-HHmmss, used in backup file names. */
export function fileTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `base` if nothing exists there yet, otherwise `base-1`, `base-2`, … (never overwrites a backup). */
export function freePath(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Writes via a temp file + rename, so a crash never leaves a half-written file.
 * Files in userData hold personal data: owner-only (0600) on POSIX.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Reads and validates a JSON file. A missing file yields `fallback()`. An
 * unreadable or invalid file is kept for the user as `<name>.corrupt-<timestamp>`
 * and `fallback()` is returned, so the app still starts.
 */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>, fallback: () => T, now: () => Date = () => new Date()): T {
  if (!existsSync(path)) return fallback();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  renameSync(path, freePath(`${path}.corrupt-${fileTimestamp(now())}`));
  return fallback();
}
