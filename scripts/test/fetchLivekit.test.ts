import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVEKIT_TARGETS,
  LIVEKIT_VERSION,
  assetUrl,
  extractTarGzEntry,
  extractZipEntry,
  fetchLivekit,
  parseChecksums,
  targetFor,
} from '../lib/livekit.mjs';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-lk-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Minimal zip writer (stored + deflated entries) to feed the extractor. */
function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Minimal ustar writer. */
function makeTarGz(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100, 'utf8');
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('LiveKit release pins (spec §8.1)', () => {
  it('pins 1.13.7 and the official Windows zip hash', () => {
    expect(LIVEKIT_VERSION).toBe('1.13.7');
    expect(LIVEKIT_TARGETS['win-x64']).toMatchObject({
      asset: 'livekit_1.13.7_windows_amd64.zip',
      sha256: 'e539e7d2f75807b9c9202cd2a0bf2cb3d52fc4c52978a6953e0f47bc339fe77f',
      binary: 'livekit-server.exe',
    });
    expect(LIVEKIT_TARGETS['linux-x64']!.asset).toBe('livekit_1.13.7_linux_amd64.tar.gz');
    expect(LIVEKIT_TARGETS['linux-arm64']!.asset).toBe('livekit_1.13.7_linux_arm64.tar.gz');
    expect(assetUrl('win-x64')).toBe('https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_windows_amd64.zip');
  });

  it('maps the build machine to an electron-builder ${os}-${arch} folder', () => {
    expect(targetFor('win32', 'x64')).toBe('win-x64');
    expect(targetFor('linux', 'x64')).toBe('linux-x64');
    expect(targetFor('linux', 'arm64')).toBe('linux-arm64');
    expect(targetFor('darwin', 'arm64')).toBeNull(); // no official macOS binary (spec §8.1)
  });

  it('parses checksums.txt', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    const map = parseChecksums(`${a}  a.zip\n\n${b} *b.tar.gz\r\nnot-a-hash  c.zip\n`);
    expect(map.get('a.zip')).toBe(a);
    expect(map.get('b.tar.gz')).toBe('b'.repeat(64));
    expect(map.has('c.zip')).toBe(false);
  });
});

describe('archive extraction', () => {
  it('extracts one entry from a zip (stored and deflated)', () => {
    const exe = Buffer.from('MZ fake exe '.repeat(100));
    const zip = makeZip([
      { name: 'LICENSE', data: Buffer.from('Apache') },
      { name: 'livekit-server.exe', data: exe, deflate: true },
    ]);
    expect(extractZipEntry(zip, 'livekit-server.exe')).toEqual(exe);
    expect(extractZipEntry(zip, 'LICENSE')?.toString()).toBe('Apache');
    expect(extractZipEntry(zip, 'missing')).toBeNull();
  });

  it('refuses a zip entry whose CRC does not match', () => {
    const zip = makeZip([{ name: 'x', data: Buffer.from('hello') }]);
    const tampered = Buffer.from(zip);
    tampered[30 + 1] = 'j'.charCodeAt(0); // first data byte of entry "x"
    expect(() => extractZipEntry(tampered, 'x')).toThrow(/CRC/);
  });

  it('extracts one entry from a tar.gz', () => {
    const bin = Buffer.from('\x7fELF fake '.repeat(300));
    const tgz = makeTarGz([
      { name: 'LICENSE', data: Buffer.from('Apache') },
      { name: 'livekit-server', data: bin },
    ]);
    expect(extractTarGzEntry(tgz, 'livekit-server')).toEqual(bin);
    expect(extractTarGzEntry(tgz, 'nope')).toBeNull();
  });
});

describe('fetchLivekit', () => {
  const exe = Buffer.from('MZ livekit '.repeat(50));
  const zip = makeZip([
    { name: 'LICENSE', data: Buffer.from('Apache License 2.0') },
    { name: 'livekit-server.exe', data: exe, deflate: true },
  ]);
  const pins = { 'win-x64': { ...LIVEKIT_TARGETS['win-x64']!, sha256: sha256(zip) } };
  const checksums = `${sha256(zip)}  ${pins['win-x64'].asset}\n`;

  function fakeFetch(responses: Record<string, () => Response>, log: string[] = []) {
    return async (url: string) => {
      log.push(url);
      const name = url.split('/').pop()!;
      const make = responses[name];
      if (!make) return new Response('not found', { status: 404 });
      return make();
    };
  }

  it('downloads, verifies against the pin and checksums.txt, and installs the binary with its license', async () => {
    const outDir = tempDir();
    const log: string[] = [];
    const result = await fetchLivekit({
      target: 'win-x64',
      outDir,
      pins,
      retryDelayMs: 1,
      fetchImpl: fakeFetch({ [pins['win-x64'].asset]: () => new Response(zip), 'checksums.txt': () => new Response(checksums) }, log),
      log: () => {},
    });
    expect(result.downloaded).toBe(true);
    expect(readFileSync(join(outDir, 'win-x64', 'livekit-server.exe'))).toEqual(exe);
    expect(readFileSync(join(outDir, 'win-x64', 'LICENSE'), 'utf8')).toContain('Apache');
    expect(log.some((u) => u.endsWith('checksums.txt'))).toBe(true);

    // Second run: the installed binary matches its stamp, nothing is downloaded.
    const again = await fetchLivekit({ target: 'win-x64', outDir, pins, fetchImpl: fakeFetch({}), log: () => {} });
    expect(again.downloaded).toBe(false);
  });

  it('refuses an asset whose hash differs from the pin (and installs nothing)', async () => {
    const outDir = tempDir();
    const evil = makeZip([{ name: 'livekit-server.exe', data: Buffer.from('evil') }]);
    await expect(fetchLivekit({
      target: 'win-x64',
      outDir,
      pins,
      retryDelayMs: 1,
      fetchImpl: fakeFetch({ [pins['win-x64'].asset]: () => new Response(evil), 'checksums.txt': () => new Response(checksums) }),
      log: () => {},
    })).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(outDir, 'win-x64', 'livekit-server.exe'))).toBe(false);
  });

  it('refuses when the official checksums.txt disagrees with the pin', async () => {
    const outDir = tempDir();
    await expect(fetchLivekit({
      target: 'win-x64',
      outDir,
      pins,
      retryDelayMs: 1,
      fetchImpl: fakeFetch({ [pins['win-x64'].asset]: () => new Response(zip), 'checksums.txt': () => new Response(`${'0'.repeat(64)}  ${pins['win-x64'].asset}\n`) }),
      log: () => {},
    })).rejects.toThrow(/checksums\.txt/);
  });

  it('uses a cached archive only when its hash matches, and retries flaky downloads', async () => {
    const outDir = tempDir();
    const cacheDir = tempDir();
    writeFileSync(join(cacheDir, pins['win-x64'].asset), zip);
    writeFileSync(join(cacheDir, 'checksums.txt'), checksums);
    const log: string[] = [];
    const cached = await fetchLivekit({ target: 'win-x64', outDir, cacheDir, pins, fetchImpl: fakeFetch({}, log), log: () => {} });
    expect(cached.downloaded).toBe(false);
    expect(log).toEqual([]);
    expect(readFileSync(join(outDir, 'win-x64', 'livekit-server.exe'))).toEqual(exe);

    // A corrupt cache is ignored; the download fails twice, then succeeds.
    const outDir2 = tempDir();
    const cacheDir2 = tempDir();
    mkdirSync(cacheDir2, { recursive: true });
    writeFileSync(join(cacheDir2, pins['win-x64'].asset), Buffer.from('corrupt'));
    let failures = 2;
    const fetched = await fetchLivekit({
      target: 'win-x64',
      outDir: outDir2,
      cacheDir: cacheDir2,
      pins,
      retryDelayMs: 1,
      fetchImpl: async (url: string) => {
        if (url.endsWith('.zip') && failures-- > 0) throw new TypeError('fetch failed');
        return fakeFetch({ [pins['win-x64'].asset]: () => new Response(zip), 'checksums.txt': () => new Response(checksums) })(url);
      },
      log: () => {},
    });
    expect(fetched.downloaded).toBe(true);
    expect(readFileSync(join(cacheDir2, pins['win-x64'].asset))).toEqual(zip); // cache refreshed
  });
});
