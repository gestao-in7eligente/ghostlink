import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, ensureDataDirs, writeFileAtomic, writeSecretFile } from '../src/config/paths.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-paths-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('data dir layout', () => {
  it('maps every file to its fixed place', () => {
    const p = dataPaths(dir);
    expect(p.db).toBe(join(dir, 'ghostlink.db'));
    expect(p.certFile).toBe(join(dir, 'tls', 'server.crt'));
    expect(p.keyFile).toBe(join(dir, 'tls', 'server.key'));
    expect(p.setupCodeFile).toBe(join(dir, 'setup-code.txt'));
    expect(p.backupsDir).toBe(join(dir, 'backups'));
  });

  it('creates missing directories, including nested parents', () => {
    const nested = join(dir, 'a', 'b');
    const p = ensureDataDirs(nested);
    expect(statSync(p.tlsDir).isDirectory()).toBe(true);
    expect(statSync(p.backupsDir).isDirectory()).toBe(true);
    expect(() => ensureDataDirs(nested)).not.toThrow();
  });
});

describe('atomic writes', () => {
  it('replaces the content and leaves no temp file behind', () => {
    const file = join(dir, 'x.txt');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['x.txt']);
  });

  it.skipIf(process.platform === 'win32')('writes secrets with mode 0600 even over a 0644 file', () => {
    const file = join(dir, 'secret.txt');
    writeFileAtomic(file, 'public', 0o644);
    writeSecretFile(file, 'secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates data directories as 0700', () => {
    const p = ensureDataDirs(join(dir, 'fresh'));
    expect(statSync(p.root).mode & 0o777).toBe(0o700);
    expect(statSync(p.tlsDir).mode & 0o777).toBe(0o700);
  });

  it('does not leave a temp file when the target directory is missing', () => {
    expect(() => writeFileAtomic(join(dir, 'missing', 'x.txt'), 'x')).toThrow();
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});
