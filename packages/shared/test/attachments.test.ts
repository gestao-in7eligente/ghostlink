import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  CHAT_LIMITS,
  FEATURE_ATTACHMENTS,
  attachmentUploadBeginSchema,
  cleanFileName,
  fileInfo,
  fileSignatureInput,
  fileTarget,
  isImageTooLarge,
  serverStorageSchemaClient,
  uploadBeginSchema,
} from '../src/index.js';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const PNG = bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(300), be32(200), [8, 6, 0, 0, 0]);
const ftyp = (brand: string) => bytes(be32(24), 'ftyp', brand, be32(0), 'isomiso2');
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f], [0x42, 0x86, 0x81, 0x01], [0x42, 0x82, 0x84], 'webm', [0x42, 0x87, 0x81, 0x04]);
const MKV = bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3], [0x42, 0x82, 0x88], 'matroska');

const CHANNEL = 'A'.repeat(26);
const SHA = 'f'.repeat(64);

describe('fileInfo: the type comes from the bytes (spec 2026-10-01-anexos §2)', () => {
  it('images carry their sides', () => {
    expect(fileInfo(PNG)).toEqual({ kind: 'image', mime: 'image/png', width: 300, height: 200 });
  });

  it('MP4 and WebM are video; MP3, OGG and M4A are audio', () => {
    expect(fileInfo(ftyp('isom'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(fileInfo(ftyp('mp42'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(fileInfo(WEBM)).toEqual({ kind: 'video', mime: 'video/webm' });
    expect(fileInfo(ftyp('M4A '))).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    expect(fileInfo(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    expect(fileInfo(bytes([0xff, 0xfb, 0x90, 0x64]))).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    expect(fileInfo(bytes('OggS', [0, 2]))).toEqual({ kind: 'audio', mime: 'audio/ogg' });
  });

  it('PDF is a file of its own type; everything else is application/octet-stream', () => {
    expect(fileInfo(bytes('%PDF-1.7\n'))).toEqual({ kind: 'file', mime: 'application/pdf' });
    for (const other of [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      bytes('<!doctype html><script>alert(1)</script>'),
      bytes('PK', [3, 4]),
      ftyp('heic'), // an image a browser does not show
      MKV,
      PNG.slice(0, 20), // an image whose header is cut
      bytes([0xff, 0xf1, 0x50, 0x80]), // AAC (ADTS), not Layer III
      new Uint8Array(0),
    ]) {
      expect(fileInfo(other)).toEqual({ kind: 'file', mime: 'application/octet-stream' });
    }
  });
});

describe('isImageTooLarge', () => {
  it('refuses more than 8192 px on a side or more than 40 MP', () => {
    expect(isImageTooLarge({ width: 8192, height: 4096 })).toBe(false);
    expect(isImageTooLarge({ width: 8193, height: 10 })).toBe(true);
    expect(isImageTooLarge({ width: 10, height: 8193 })).toBe(true);
    expect(isImageTooLarge({ width: 8000, height: 5000 })).toBe(false);
    expect(isImageTooLarge({ width: 8000, height: 5001 })).toBe(true);
    expect(isImageTooLarge({})).toBe(false);
  });
});

describe('cleanFileName (main spec §7)', () => {
  it('keeps an ordinary name', () => {
    expect(cleanFileName('Relatório final (2).pdf')).toBe('Relatório final (2).pdf');
  });

  it('drops controls, bidi and zero-width characters and replaces what Windows forbids', () => {
    expect(cleanFileName('a\u0000b‮cod.exe​')).toBe('abcod.exe');
    expect(cleanFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(cleanFileName('a:b*c?d"e<f>g|h\\i.txt')).toBe('a_b_c_d_e_f_g_h_i.txt');
    expect(cleanFileName('  muitos   espaços\t\n.txt  ')).toBe('muitos espaços.txt');
    expect(cleanFileName('fim com pontos...')).toBe('fim com pontos');
  });

  it('is never empty', () => {
    for (const raw of ['', '   ', '...', '​‮']) expect(cleanFileName(raw)).toBe('file');
  });

  it('cuts a long name to 255 code points, keeping the extension', () => {
    const name = cleanFileName(`${'🙂'.repeat(400)}.jpeg`);
    expect(Array.from(name)).toHaveLength(ATTACHMENT_LIMITS.nameMax);
    expect(name.endsWith('🙂.jpeg')).toBe(true);
  });

  it('is idempotent', () => {
    for (const raw of ['a:b.txt', ' x . ', `${'n'.repeat(300)}.md`, 'é.png']) {
      expect(cleanFileName(cleanFileName(raw))).toBe(cleanFileName(raw));
    }
  });
});

describe('upload.begin for an attachment', () => {
  const ok = { purpose: 'attachment', channelId: CHANNEL, name: 'foto.png', size: 1000, sha256: SHA };

  it('takes the channel, the name, the size and the hash, nothing else', () => {
    expect(uploadBeginSchema.parse(ok)).toEqual(ok);
    expect(attachmentUploadBeginSchema.parse(ok)).toEqual(ok);
    expect(uploadBeginSchema.parse({ purpose: 'avatar', size: 10, sha256: SHA })).toEqual({ purpose: 'avatar', size: 10, sha256: SHA });
    for (const bad of [
      { ...ok, channelId: undefined },
      { ...ok, channelId: '../x' },
      { ...ok, name: '' },
      { ...ok, name: 'x'.repeat(ATTACHMENT_LIMITS.nameInputMax + 1) },
      { ...ok, size: 0 },
      { ...ok, size: 1.5 },
      { ...ok, sha256: 'F'.repeat(64) },
      { ...ok, extra: 1 },
      { ...ok, purpose: 'icon' },
    ]) {
      expect(uploadBeginSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('the rest of the contract', () => {
  it('signs a fileId as itself, under the frozen label', () => {
    expect(fileTarget(CHANNEL)).toBe(CHANNEL);
    expect(fileSignatureInput(fileTarget(CHANNEL), 'sid1', 1_800_000_600)).toBe(`ghostlink-file-v1\n${CHANNEL}\nsid1\n1800000600`);
  });

  it('names the feature, keeps the spec limits and parses server.storage', () => {
    expect(FEATURE_ATTACHMENTS).toBe('attachments');
    expect(CHAT_LIMITS.maxAttachments).toBe(10);
    expect(ATTACHMENT_LIMITS.uploadLimitMb.default).toBe(25);
    expect(ATTACHMENT_LIMITS.storageQuotaMb.default).toBe(10_240);
    const storage = { usedBytes: 123, uploadLimitMb: 25, storageQuotaMb: 10_240 };
    expect(serverStorageSchemaClient.parse({ ...storage, extra: 1 })).toEqual(storage);
  });
});
