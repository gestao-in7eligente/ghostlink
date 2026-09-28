import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  tlsDir: string;
  certFile: string;
  keyFile: string;
  setupCodeFile: string;
  backupsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const tlsDir = join(dataDir, 'tls');
  return {
    root: dataDir,
    db: join(dataDir, 'ghostlink.db'),
    tlsDir,
    certFile: join(tlsDir, 'server.crt'),
    keyFile: join(tlsDir, 'server.key'),
    setupCodeFile: join(dataDir, 'setup-code.txt'),
    backupsDir: join(dataDir, 'backups'),
  };
}

/** Creates the data directory tree (0700 on POSIX) and returns its paths. */
export function ensureDataDirs(dataDir: string): DataPaths {
  const p = dataPaths(dataDir);
  for (const dir of [p.root, p.tlsDir, p.backupsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return p;
}

/**
 * Writes via a temp file + rename so a crash never leaves a half-written file.
 * `mode` is applied on POSIX; Windows ignores POSIX modes.
 */
export function writeFileAtomic(path: string, content: string, mode = 0o644): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode });
    if (process.platform !== 'win32') chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Secrets (TLS key, setup code) are readable by the owner only: 0600 (spec §7). */
export function writeSecretFile(path: string, content: string): void {
  writeFileAtomic(path, content, 0o600);
}
