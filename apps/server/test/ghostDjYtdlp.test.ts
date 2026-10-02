import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { parsePlayQuery } from '../src/ghostDj/youtube.js';
import { YtDlpBinary, YtDlpRunner, checksumFor, classifyYtdlpError, type SpawnFn } from '../src/ghostDj/ytdlp.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-ytdlp-'));
  dirs.push(dir);
  return dir;
}

const TAG = '2026.09.30';
const BINARY = Buffer.from('#!/bin/sh\necho fake yt-dlp\n');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** GitHub's release pages as yt-dlp's updater sees them: latest → tag, assets behind a redirect. */
async function fakeGithub(sums: string): Promise<{ base: string; downloads: () => number }> {
  let downloads = 0;
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path === '/yt-dlp/yt-dlp/releases/latest') {
      res.writeHead(302, { Location: `/yt-dlp/yt-dlp/releases/tag/${TAG}` }).end();
    } else if (path === `/yt-dlp/yt-dlp/releases/tag/${TAG}`) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>');
    } else if (path === `/yt-dlp/yt-dlp/releases/download/${TAG}/SHA2-256SUMS`) {
      res.writeHead(200).end(sums);
    } else if (path === `/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_linux`) {
      res.writeHead(302, { Location: '/objects/yt-dlp_linux' }).end();
    } else if (path === '/objects/yt-dlp_linux') {
      downloads++;
      res.writeHead(200, { 'Content-Length': BINARY.length }).end(BINARY);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/yt-dlp/yt-dlp`, downloads: () => downloads };
}

const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

describe('Ghost DJ: the yt-dlp binary (spec §2)', () => {
  it('installs the release binary whose SHA-256 matches its SHA2-256SUMS, keeps it, and checks it again at the next start', async () => {
    const gh = await fakeGithub(`${'0'.repeat(64)}  yt-dlp.exe\n${sha256(BINARY)}  yt-dlp_linux\n${'1'.repeat(64)}  yt-dlp_macos\n`);
    const dir = tempDir();
    const binary = new YtDlpBinary({ dir, logger: silentLogger, releases: gh.base, asset: 'yt-dlp_linux' });
    expect(binary.path).toBeNull();
    expect(await binary.refresh()).toBe('installed');
    expect(binary.path).toBe(join(dir, exeName));
    expect(binary.version).toBe(TAG);
    expect(readFileSync(join(dir, exeName))).toEqual(BINARY);
    expect(await binary.refresh()).toBe('current');
    expect(gh.downloads()).toBe(1);

    // A later start trusts the file only while its bytes still match.
    const again = new YtDlpBinary({ dir, logger: silentLogger, releases: gh.base, asset: 'yt-dlp_linux' });
    await again.load();
    expect(again.path).toBe(join(dir, exeName));
    writeFileSync(join(dir, exeName), 'tampered');
    const tampered = new YtDlpBinary({ dir, logger: silentLogger, releases: gh.base, asset: 'yt-dlp_linux' });
    await tampered.load();
    expect(tampered.path).toBeNull();
    expect(existsSync(join(dir, exeName))).toBe(false);
  });

  it('refuses a binary whose checksum does not match, or with no single line for it, and leaves nothing behind', async () => {
    for (const sums of [`${'a'.repeat(64)}  yt-dlp_linux\n`, `${sha256(BINARY)}  yt-dlp_linux_aarch64\n`, `${sha256(BINARY)}  yt-dlp_linux\n${sha256(BINARY)}  yt-dlp_linux\n`]) {
      const gh = await fakeGithub(sums);
      const dir = tempDir();
      const binary = new YtDlpBinary({ dir, logger: silentLogger, releases: gh.base, asset: 'yt-dlp_linux' });
      expect(await binary.refresh()).toBe('failed');
      expect(binary.path).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('reads SHA2-256SUMS strictly', () => {
    const sums = `${'A'.repeat(64)}  yt-dlp_linux\n${'b'.repeat(64)} *yt-dlp.exe\r\n`;
    expect(checksumFor(sums, 'yt-dlp_linux')).toBe('a'.repeat(64));
    expect(checksumFor(sums, 'yt-dlp.exe')).toBe('b'.repeat(64));
    expect(checksumFor(sums, 'yt-dlp_linux_aarch64')).toBeNull();
  });
});

/** A spawn that records the arguments and runs a tiny Node script in yt-dlp's place. */
function fakeYtdlp(out: { stdout?: string; stderr?: string; code?: number }): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const script = `process.stdout.write(${JSON.stringify(out.stdout ?? '')}); process.stderr.write(${JSON.stringify(out.stderr ?? '')}); process.exitCode = ${out.code ?? 0};`;
  return {
    calls,
    spawn: (_command, args) => {
      calls.push([...args]);
      return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
}

describe('Ghost DJ: running yt-dlp safely (spec §2)', () => {
  it('passes the target last after --, searches with ytsearch1:, and adds cookies.txt only when it exists', async () => {
    const dir = tempDir();
    const yt = fakeYtdlp({ stdout: JSON.stringify({ _type: 'playlist', entries: [{ id: 'dQw4w9WgXcQ', title: 'Never', duration: 213 }] }) });
    const runner = new YtDlpRunner({ binary: () => '/opt/yt-dlp', dir, spawn: yt.spawn, nodePath: '/usr/bin/node' });
    const search = parsePlayQuery('--exec rm -rf /')!;
    expect(search).toEqual({ kind: 'search', query: '--exec rm -rf /', url: 'ytsearch1:--exec rm -rf /' });
    expect(await runner.resolve(search)).toEqual({
      ok: true,
      tracks: [{ id: 'dQw4w9WgXcQ', title: 'Never', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', durationSec: 213 }],
      playlistTitle: null,
      skipped: 0,
    });
    const first = yt.calls[0]!;
    expect(first.slice(-2)).toEqual(['--', 'ytsearch1:--exec rm -rf /']);
    expect(first).toContain('--ignore-config');
    expect(first).toEqual(expect.arrayContaining(['--js-runtimes', 'node:/usr/bin/node']));
    expect(first).not.toContain('--cookies');

    writeFileSync(join(dir, 'cookies.txt'), '# Netscape HTTP Cookie File\n');
    await runner.resolve(parsePlayQuery('https://youtu.be/dQw4w9WgXcQ')!);
    const second = yt.calls[1]!;
    expect(second[second.indexOf('--cookies') + 1]).toBe(join(dir, 'cookies.txt'));
    expect(second).toContain('--no-playlist');
    expect(second.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    expect(runner.audioArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual(expect.arrayContaining(['--cookies', join(dir, 'cookies.txt'), '-o', '-']));
  });

  it('tells a YouTube block apart, and takes from a playlist only what it can play', async () => {
    const dir = tempDir();
    const blocked = fakeYtdlp({ stderr: "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies", code: 1 });
    const runner = new YtDlpRunner({ binary: () => '/opt/yt-dlp', dir, spawn: blocked.spawn });
    expect(await runner.resolve(parsePlayQuery('qualquer')!)).toEqual({ ok: false, error: 'blocked', blockedWithCookies: false });
    expect(classifyYtdlpError('ERROR: [youtube] x: Video unavailable')).toBe('unavailable');

    const entries = [
      { id: 'aaaaaaaaaaa', title: 'ok', duration: 100 },
      { id: 'bbbbbbbbbbb', title: 'ao vivo', live_status: 'is_live' },
      { id: 'ccccccccccc', title: 'longa', duration: 4 * 3_600 },
      { id: 'ddddddddddd', title: '[Private video]' },
      { id: 'not-an-id', title: 'x' },
    ];
    const list = fakeYtdlp({ stdout: JSON.stringify({ _type: 'playlist', title: 'Lista', entries }) });
    const listRunner = new YtDlpRunner({ binary: () => '/opt/yt-dlp', dir, spawn: list.spawn });
    const result = await listRunner.resolve(parsePlayQuery('https://www.youtube.com/playlist?list=PLabc123')!);
    expect(result).toMatchObject({ ok: true, playlistTitle: 'Lista', skipped: 4, tracks: [{ id: 'aaaaaaaaaaa' }] });
    expect(list.calls[0]).toEqual(expect.arrayContaining(['--flat-playlist', '--playlist-end', '50']));
  });

  it('takes only YouTube video and playlist links, rebuilt from their ids', () => {
    expect(parsePlayQuery('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&t=30')).toEqual({ kind: 'video', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(parsePlayQuery('youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({ kind: 'video', id: 'dQw4w9WgXcQ' });
    expect(parsePlayQuery('https://music.youtube.com/playlist?list=OLAK5uy_abc')).toEqual({ kind: 'playlist', id: 'OLAK5uy_abc', url: 'https://www.youtube.com/playlist?list=OLAK5uy_abc' });
    for (const bad of [
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/@canal',
      'file:///etc/passwd',
      'https://vimeo.com/1',
      '   ',
    ]) {
      expect(parsePlayQuery(bad), bad).toBeNull();
    }
  });
});
