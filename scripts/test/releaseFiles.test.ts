import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECKSUMS_FILE,
  checksumsFor,
  parseChecksums,
  releaseVersionFromTag,
  serverPackageEntries,
  tarGz,
  unshippedImports,
  type TarEntry,
} from '../lib/releaseFiles.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-release-files-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hasTool = (tool: string) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;

/** Minimal ustar reader: enough to check what tarGz wrote, header checksums included. */
function readTarGz(archive: Buffer): { name: string; mode: number; type: string; mtime: number; uname: string; data: Buffer }[] {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const stored = parseInt(field(148, 8).trim(), 8);
    const copy = Buffer.from(header);
    copy.fill(' ', 148, 156);
    expect(copy.reduce((sum, b) => sum + b, 0)).toBe(stored);
    expect(field(257, 6)).toBe('ustar');
    const size = parseInt(field(124, 12), 8);
    entries.push({
      name: field(0, 100),
      mode: parseInt(field(100, 8), 8),
      type: field(156, 1),
      mtime: parseInt(field(136, 12), 8),
      uname: field(265, 32),
      data: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('releaseVersionFromTag', () => {
  it('accepts the tag that matches every package.json and has release notes', () => {
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string;
    expect(releaseVersionFromTag(`v${version}`, repoRoot)).toBe(version);
  });

  it.each(['0.1.0', 'v0.1', 'v0.1.0-rc.1', 'v01.1.0', 'main', 'refs/tags/v0.1.0', 'v0.1.0\n', ''])('refuses the tag %j', (tag) => {
    expect(() => releaseVersionFromTag(tag, repoRoot)).toThrow(/not a release tag/);
  });

  it('refuses a tag that does not match the package versions', () => {
    expect(() => releaseVersionFromTag('v9.9.9', repoRoot)).toThrow(/has version/);
  });

  it('refuses a release without notes', () => {
    const root = tempDir();
    for (const dir of ['', 'apps/desktop', 'apps/server', 'packages/shared', 'packages/discord-compat']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), '{"version":"1.2.3"}');
    }
    expect(() => releaseVersionFromTag('v1.2.3', root)).toThrow(/release-notes\/1\.2\.3\.md/);
  });
});

describe('checksumsFor', () => {
  it('lists every release file in sha256sum format, sorted, without the checksum files themselves', async () => {
    const dir = tempDir();
    const files: Record<string, string> = {
      'GhostLink-Setup-0.1.0.exe': 'installer',
      'GhostLink-Setup-0.1.0.exe.ed25519': 'sig',
      'latest.yml': 'version: 0.1.0\n',
      'ghostlink-server-0.1.0.tgz': 'tgz',
    };
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    writeFileSync(join(dir, CHECKSUMS_FILE), 'stale');
    writeFileSync(join(dir, `${CHECKSUMS_FILE}.sigstore.json`), '{}');
    mkdirSync(join(dir, 'subdir'));

    const text = await checksumsFor(dir);
    expect(text.split('\n').filter(Boolean).map((l) => l.split('  ')[1])).toEqual(Object.keys(files).sort());
    const parsed = parseChecksums(text);
    for (const [name, data] of Object.entries(files)) expect(parsed.get(name)).toBe(sha256(data));

    if (hasTool('sha256sum')) {
      writeFileSync(join(dir, CHECKSUMS_FILE), text);
      const check = spawnSync('sha256sum', ['--ignore-missing', '-c', CHECKSUMS_FILE], { cwd: dir, encoding: 'utf8' });
      expect(check.status, check.stderr).toBe(0);
    }
  });

  it('refuses an empty directory and malformed lines', async () => {
    await expect(checksumsFor(tempDir())).rejects.toThrow(/no files/);
    expect(() => parseChecksums('abc  file\n')).toThrow(/malformed/);
  });
});

describe('tarGz', () => {
  const entries: TarEntry[] = [
    { name: 'dist', mode: 0o755 },
    { name: 'dist/cli.js', mode: 0o755, data: Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n') },
    { name: 'empty.txt', mode: 0o644, data: new Uint8Array(0) },
    { name: 'block.bin', mode: 0o644, data: new Uint8Array(512).fill(7) },
  ];

  it('writes a valid, deterministic ustar archive with root-owned entries', () => {
    const archive = tarGz(entries, 1_790_000_000);
    expect(tarGz(entries, 1_790_000_000).equals(archive)).toBe(true);
    const read = readTarGz(archive);
    expect(read.map((e) => [e.name, e.mode, e.type])).toEqual([
      ['dist/', 0o755, '5'],
      ['dist/cli.js', 0o755, '0'],
      ['empty.txt', 0o644, '0'],
      ['block.bin', 0o644, '0'],
    ]);
    expect(read[1]!.data.toString()).toBe('#!/usr/bin/env node\nconsole.log(1)\n');
    expect(read[3]!.data.equals(Buffer.alloc(512, 7))).toBe(true);
    for (const e of read) {
      expect(e.mtime).toBe(1_790_000_000);
      expect(e.uname).toBe('root');
    }
  });

  it('extracts with the system tar when there is one', () => {
    if (!hasTool('tar')) return;
    const dir = tempDir();
    writeFileSync(join(dir, 'pkg.tgz'), tarGz(entries, 1_790_000_000));
    mkdirSync(join(dir, 'out'));
    const result = spawnSync('tar', ['-xzf', '../pkg.tgz'], { cwd: join(dir, 'out'), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, 'out', 'dist', 'cli.js'), 'utf8')).toContain('console.log(1)');
  });

  it.each(['/etc/passwd', '../escape', 'a/../../b', `${'x'.repeat(101)}`])('refuses the entry name %j', (name) => {
    expect(() => tarGz([{ name, mode: 0o644, data: new Uint8Array(1) }], 1)).toThrow(/unsupported tar entry/);
  });
});

describe('unshippedImports', () => {
  it('allows Node built-ins and ws optional add-ons only', () => {
    const bundle = [
      'import { createRequire as r } from "node:module";',
      'import { readFileSync } from "node:fs";',
      'var a = __require("zlib"), b = __require("bufferutil"), c = require("utf-8-validate");',
      'import "node:sqlite";',
      'const msg = "import this from somewhere";',
    ].join('\n');
    expect(unshippedImports(bundle)).toEqual([]);
  });

  it('reports anything the package would have to ship', () => {
    const bundle = ['import leftPad from "left-pad";', 'var x = __require("livekit-server-sdk");', 'await import("@scope/pkg");', 'require("ws")'].join('\n');
    expect(unshippedImports(bundle)).toEqual(['@scope/pkg', 'left-pad', 'livekit-server-sdk', 'ws']);
  });
});

describe('serverPackageEntries', () => {
  function fixture(): { root: string; installSh: string } {
    const root = tempDir();
    mkdirSync(join(root, 'apps', 'server', 'dist', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '>=24.14' } }));
    writeFileSync(join(root, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n');
    writeFileSync(join(root, 'apps', 'server', 'package.json'), JSON.stringify({ version: '0.1.0', license: 'GPL-3.0-or-later', dependencies: { ws: '8.22.0' } }));
    writeFileSync(join(root, 'apps', 'server', 'dist', 'cli.js'), '#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\n');
    writeFileSync(join(root, 'apps', 'server', 'dist', 'migrations', '001_init.sql'), 'CREATE TABLE t (x);\n');
    writeFileSync(join(root, 'apps', 'server', 'dist', 'migrations', 'notes.txt'), 'not a migration');
    const installSh = join(root, 'install.sh');
    writeFileSync(installSh, '#!/usr/bin/env bash\necho install\n');
    return { root, installSh };
  }

  it('packs the bundle, migrations, a dependency-free package.json, install.sh and the license', () => {
    const { root, installSh } = fixture();
    const { version, entries } = serverPackageEntries({ repoRoot: root, installSh });
    expect(version).toBe('0.1.0');
    expect(entries.map((e) => [e.name, e.mode])).toEqual([
      ['dist', 0o755],
      ['dist/cli.js', 0o755],
      ['dist/migrations', 0o755],
      ['dist/migrations/001_init.sql', 0o644],
      ['package.json', 0o644],
      ['install.sh', 0o755],
      ['LICENSE', 0o644],
    ]);
    const manifest = JSON.parse(Buffer.from(entries.find((e) => e.name === 'package.json')!.data!).toString());
    expect(manifest).toMatchObject({
      name: 'ghostlink-server',
      version: '0.1.0',
      license: 'GPL-3.0-or-later',
      type: 'module',
      bin: { 'ghostlink-server': 'dist/cli.js' },
      engines: { node: '>=24.14' },
      dependencies: {},
    });
  });

  it('refuses a bundle that needs node_modules, a missing build or a missing install.sh', () => {
    const { root, installSh } = fixture();
    writeFileSync(join(root, 'apps', 'server', 'dist', 'cli.js'), 'import x from "livekit-server-sdk";\n');
    expect(() => serverPackageEntries({ repoRoot: root, installSh })).toThrow(/livekit-server-sdk/);
    rmSync(join(root, 'apps', 'server', 'dist', 'cli.js'));
    expect(() => serverPackageEntries({ repoRoot: root, installSh })).toThrow(/npm run build/);
    const other = fixture();
    expect(() => serverPackageEntries({ repoRoot: other.root, installSh: join(other.root, 'nope.sh') })).toThrow(/missing/);
  });
});
