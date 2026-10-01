// Attachments in channels (spec 2026-10-01-anexos-design.md §2, §5; main spec §7): upload.begin
// with purpose 'attachment' → POST /upload → msg.send's attachmentIds, the permission, the
// per-file limit and the quota, the signed GET /files/<fileId> and the clean-up.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_ATTACHMENTS,
  MB,
  PERMISSIONS,
  fileSignatureInput,
  fileTarget,
  fileUrlExpiry,
  type Message,
  type ServerStorage,
  type UploadBeginResult,
} from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createFilesModule } from '../src/files/index.js';
import { withDb } from './helpers/db.js';
import { channelId, nextClientMsgId, textFixture, type TextClient } from './text/helpers.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function png(width = 640, height = 480, extra = 300): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, randomBytes(extra)]);
}

const pdf = (extra = 500) => Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), randomBytes(extra)]);

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function https(port: number, method: string, path: string, body?: Uint8Array, headers: Record<string, string | number> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const code = (r: HttpResponse) => (JSON.parse(r.body.toString('utf8')) as { code?: string }).code;

async function setup() {
  const files = createFilesModule();
  const f = await textFixture({ extraModules: [createAvatarsModule(), files] });
  const port = f.t.server.port;
  const geral = channelId(f.owner, 'geral');
  const dir = join(f.t.dataDir, 'files');
  const begin = (c: TextClient, bytes: Uint8Array, over: Record<string, unknown> = {}) =>
    c.ok<UploadBeginResult>('upload.begin', { purpose: 'attachment', channelId: geral, name: 'arquivo', size: bytes.length, sha256: sha(bytes), ...over });
  const post = (token: string, body: Uint8Array) => https(port, 'POST', `/upload?u=${token}`, body);
  /** upload.begin + POST /upload; the fileId. */
  const upload = async (c: TextClient, bytes: Uint8Array, over: Record<string, unknown> = {}) => {
    const { uploadToken, fileId } = await begin(c, bytes, over);
    const r = await post(uploadToken, bytes);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString('utf8'))).toEqual({ fileId });
    return fileId!;
  };
  const send = (c: TextClient, attachmentIds: string[], content = '', channel = geral) =>
    c.request('msg.send', { channelId: channel, content, clientMsgId: nextClientMsgId(), attachmentIds });
  /** A GET /files path signed with this client's session (main spec §7). */
  const signed = (c: TextClient, fileId: string) => {
    const sid = String(c.welcome.sessionId);
    const e = fileUrlExpiry(Number(c.welcome.serverTime));
    const s = createHmac('sha256', String(c.welcome.fileToken)).update(fileSignatureInput(fileTarget(fileId), sid, e)).digest('base64url');
    return `/files/${fileId}?sid=${encodeURIComponent(sid)}&e=${e}&s=${s}`;
  };
  return {
    ...f,
    files,
    port,
    geral,
    begin,
    post,
    upload,
    send,
    signed,
    get: (path: string, headers: Record<string, string> = {}) => https(port, 'GET', path, undefined, headers),
    stored: () => (existsSync(dir) ? readdirSync(dir).length : 0),
    row: (fileId: string) => withDb(f.t.dataDir, (db) => db.get<{ message_id: number | null }>('SELECT message_id FROM files WHERE id = ?', fileId)),
    everyone: () => f.owner.text.roles.find((r) => r.isDefault)!,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Takes ATTACH_FILES away from @everyone. */
async function withoutAttachFiles(f: Fixture): Promise<void> {
  const everyone = f.everyone();
  await f.owner.ok('role.update', { id: everyone.id, permissions: everyone.permissions & ~PERMISSIONS.ATTACH_FILES });
}

describe('upload and msg.send with attachments', () => {
  it('stores the file, links it to the message in order, and everyone who sees the channel gets it', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    expect(f.owner.welcome.features).toContain(FEATURE_ATTACHMENTS);
    const image = png(640, 480);
    const doc = pdf();
    const { uploadToken, fileId } = await f.begin(f.owner, image, { name: 'foto‮.png' });
    expect(uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fileId).toMatch(/^[A-Z2-7]{26}$/);
    expect((await f.post(uploadToken, image)).status).toBe(200);
    const docId = await f.upload(f.owner, doc, { name: 'nota.pdf' });

    const r = await f.send(f.owner, [docId, fileId!]); // no text: the files are the message
    expect(r.ok).toBe(true);
    const { message } = r.d as { message: Message };
    expect(message.content).toBe('');
    expect(message.attachments).toEqual([
      { id: docId, name: 'nota.pdf', size: doc.length, kind: 'file', mime: 'application/pdf' },
      { id: fileId, name: 'foto.png', size: image.length, kind: 'image', mime: 'image/png', width: 640, height: 480 },
    ]);
    expect((await bia.event<{ message: Message }>('msg.new', (d) => d.message.id === message.id)).message.attachments).toEqual(message.attachments);
    const page = await bia.ok<{ messages: Message[] }>('msg.history', { channelId: f.geral });
    expect(page.messages.at(-1)?.attachments).toEqual(message.attachments);
  });

  it('BAD_ATTACHMENT for a file already used, someone else’s, of another channel, repeated, or unknown', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const other = (await f.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'outro', type: 'text' })).channel.id;
    const used = await f.upload(f.owner, pdf());
    expect((await f.send(f.owner, [used])).ok).toBe(true);
    const fresh = await f.upload(f.owner, pdf());
    const elsewhere = await f.upload(f.owner, pdf(), { channelId: other });
    const hers = await f.upload(bia, pdf());
    for (const ids of [[used], [hers], [elsewhere], [fresh, fresh], ['A'.repeat(26)]]) {
      expect((await f.send(f.owner, ids, 'x')).error?.code).toBe('BAD_ATTACHMENT');
    }
    // Nothing was half-linked: the fresh file still goes with a valid message.
    expect(f.row(fresh)?.message_id).toBeNull();
    expect((await f.send(f.owner, [fresh])).ok).toBe(true);
    expect((await f.send(f.owner, [], '')).error?.code).toBe('BAD_REQUEST'); // no text and no file
  });

  it('refuses a body that does not match the declared hash, and an image over 8192 px or 40 MP', async () => {
    const f = await setup();
    const bytes = pdf();
    const { uploadToken } = await f.begin(f.owner, bytes);
    const tampered = Buffer.from(bytes);
    tampered[100]! ^= 1;
    expect(code(await f.post(uploadToken, tampered))).toBe('BAD_REQUEST');
    for (const huge of [png(8193, 10), png(8000, 5001)]) {
      const t = await f.begin(f.owner, huge);
      const r = await f.post(t.uploadToken, huge);
      expect(r.status).toBe(400);
      expect(code(r)).toBe('IMAGE_TOO_LARGE');
    }
    expect(f.stored()).toBe(0);
  });
});

describe('permission (ATTACH_FILES + VIEW_CHANNEL + SEND_MESSAGES)', () => {
  it('without ATTACH_FILES: upload.begin and msg.send with files are FORBIDDEN; a hidden channel is NOT_FOUND', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const early = await f.upload(bia, pdf()); // uploaded while she still could
    await withoutAttachFiles(f);
    const bytes = pdf();
    expect(await bia.fail('upload.begin', { purpose: 'attachment', channelId: f.geral, name: 'x', size: bytes.length, sha256: sha(bytes) })).toBe('FORBIDDEN');
    expect((await f.send(bia, [early])).error?.code).toBe('FORBIDDEN');
    expect((await f.send(bia, [], 'só texto')).ok).toBe(true);

    const secret = (await f.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'segredo', type: 'text', private: true })).channel.id;
    expect(await bia.fail('upload.begin', { purpose: 'attachment', channelId: secret, name: 'x', size: 10, sha256: sha(bytes) })).toBe('NOT_FOUND');
  });

  it('a token whose member lost the permission meanwhile is refused at POST', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const bytes = pdf();
    const { uploadToken } = await f.begin(bia, bytes);
    await withoutAttachFiles(f);
    expect((await f.post(uploadToken, bytes)).status).toBe(403);
    expect(f.stored()).toBe(0);
  });
});

describe('limits (server.update uploadLimitMb / storageQuotaMb, MANAGE_SERVER)', () => {
  it('the per-file limit: FILE_TOO_LARGE at upload.begin, and at POST once lowered', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    expect(await bia.fail('server.update', { uploadLimitMb: 100 })).toBe('FORBIDDEN');
    const d = await f.owner.ok<{ uploadLimitMb: number }>('server.update', { uploadLimitMb: 1 });
    expect(d.uploadLimitMb).toBe(1);
    expect((await bia.event<{ uploadLimitMb: number }>('server.updated')).uploadLimitMb).toBe(1);
    expect(await bia.fail('upload.begin', { purpose: 'attachment', channelId: f.geral, name: 'x', size: MB + 1, sha256: 'a'.repeat(64) })).toBe('FILE_TOO_LARGE');
    expect(await f.owner.fail('server.update', { uploadLimitMb: 0 })).toBe('BAD_REQUEST');

    const big = pdf(MB / 2);
    const { uploadToken } = await f.begin(bia, big);
    await f.owner.ok('server.update', { uploadLimitMb: 1, storageQuotaMb: 10 });
    withDb(f.t.dataDir, (db) => db.run('UPDATE server_meta SET upload_limit_mb = 0')); // below any file
    const r = await f.post(uploadToken, big);
    expect(r.status).toBe(413);
    expect(code(r)).toBe('FILE_TOO_LARGE');
  });

  it('the quota: QUOTA_EXCEEDED once the stored files would pass it; server.storage tells the use', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    await f.owner.ok('server.update', { storageQuotaMb: 1 });
    const first = pdf(600 * 1024);
    await f.upload(bia, first);
    const second = pdf(600 * 1024);
    expect(await bia.fail('upload.begin', { purpose: 'attachment', channelId: f.geral, name: 'x', size: second.length, sha256: sha(second) })).toBe('QUOTA_EXCEEDED');
    const storage = await f.owner.ok<ServerStorage>('server.storage', {});
    expect(storage).toEqual({ usedBytes: first.length, uploadLimitMb: 25, storageQuotaMb: 1 });
    expect(await bia.fail('server.storage', {})).toBe('FORBIDDEN');

    // Two uploads begun under the quota: only the first to arrive fits.
    await f.owner.ok('server.update', { storageQuotaMb: 2 });
    const a = pdf(800 * 1024);
    const b = pdf(800 * 1024);
    const ta = await f.begin(bia, a);
    const tb = await f.begin(bia, b);
    expect((await f.post(ta.uploadToken, a)).status).toBe(200);
    const late = await f.post(tb.uploadToken, b);
    expect(late.status).toBe(507);
    expect(code(late)).toBe('QUOTA_EXCEEDED');
  });
});

describe('GET /files/<fileId> (signed, VIEW_CHANNEL at request time)', () => {
  async function sent(f: Fixture, bytes: Uint8Array, name: string) {
    const fileId = await f.upload(f.owner, bytes, { name });
    expect((await f.send(f.owner, [fileId])).ok).toBe(true);
    return fileId;
  }

  it('serves a member who sees the channel, with Range, nosniff and attachment for documents', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const doc = pdf(2000);
    const docId = await sent(f, doc, 'Relatório "final".pdf');
    const whole = await f.get(f.signed(bia, docId));
    expect(whole.status).toBe(200);
    expect(whole.body.equals(doc)).toBe(true);
    expect(whole.headers['content-type']).toBe('application/pdf');
    expect(whole.headers['x-content-type-options']).toBe('nosniff');
    expect(whole.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''Relat%C3%B3rio%20_final_.pdf`);
    expect(whole.headers['cache-control']).toBe('private, max-age=600');
    expect(whole.headers['access-control-allow-origin']).toBe('*');

    const part = await f.get(f.signed(bia, docId), { Range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${doc.length}`);
    expect(part.body.equals(doc.subarray(10, 20))).toBe(true);
    expect((await f.get(f.signed(bia, docId), { Range: `bytes=${doc.length}-` })).status).toBe(416);

    const imageId = await sent(f, png(), 'foto.png');
    const image = await f.get(f.signed(bia, imageId));
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('404 once the member no longer sees the channel; 403 without a valid signature', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const docId = await sent(f, pdf(), 'a.pdf');
    expect((await f.get(f.signed(bia, docId))).status).toBe(200);
    await f.owner.ok('channel.update', { id: f.geral, private: true });
    expect((await f.get(f.signed(bia, docId))).status).toBe(404);
    expect((await f.get(f.signed(f.owner, docId))).status).toBe(200);
    expect((await f.get(`/files/${docId}`)).status).toBe(403);
    const forged = f.signed(bia, docId).replace(/s=[^&]+$/, `s=${'A'.repeat(43)}`);
    expect((await f.get(forged)).status).toBe(403);
  });

  it('an upload not sent yet is only its uploader’s', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const fileId = await f.upload(f.owner, pdf());
    expect((await f.get(f.signed(f.owner, fileId))).status).toBe(200);
    expect((await f.get(f.signed(bia, fileId))).status).toBe(404);
  });
});

describe('clean-up', () => {
  it('deletes an upload no message used within 1 h; keeps the used ones', async () => {
    const f = await setup();
    const unused = await f.upload(f.owner, pdf());
    const used = await f.upload(f.owner, pdf());
    expect((await f.send(f.owner, [used])).ok).toBe(true);
    f.clock.now += 59 * 60_000;
    f.files.sweep();
    expect(f.row(unused)).toBeDefined();
    f.clock.now += 2 * 60_000;
    f.files.sweep();
    expect(f.row(unused)).toBeUndefined();
    expect(f.row(used)).toBeDefined();
    expect(f.stored()).toBe(1);
    expect((await f.send(f.owner, [unused])).error?.code).toBe('BAD_ATTACHMENT');
  });

  it('deleting the message, or its channel, deletes its files', async () => {
    const f = await setup();
    const fileId = await f.upload(f.owner, pdf());
    const { message } = (await f.send(f.owner, [fileId])).d as { message: Message };
    await f.owner.ok('msg.delete', { id: message.id });
    expect(f.row(fileId)).toBeUndefined();
    expect(f.stored()).toBe(0);
    expect((await f.get(f.signed(f.owner, fileId))).status).toBe(404);

    const other = (await f.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'temporario', type: 'text' })).channel.id;
    const sentThere = await f.upload(f.owner, pdf(), { channelId: other });
    const waiting = await f.upload(f.owner, pdf(), { channelId: other });
    expect((await f.send(f.owner, [sentThere], '', other)).ok).toBe(true);
    expect(f.stored()).toBe(2);
    await f.owner.ok('channel.delete', { id: other });
    expect(f.row(sentThere)).toBeUndefined();
    expect(f.row(waiting)).toBeUndefined();
    expect(f.stored()).toBe(0);
  });
});
