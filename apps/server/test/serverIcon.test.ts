// The server icon (spec 2026-10-01-icone-do-servidor): the profile photo's path with
// `purpose: 'icon'` and MANAGE_SERVER, server.updated with `icon`, the signed GET /avatars
// serving it, and server.iconClear.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_SERVER_ICON, PERMISSIONS, avatarTarget, fileSignatureInput, fileUrlExpiry, type ServerInfo } from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { textFixture, type TextClient } from './text/helpers.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The server reads only the header: a 256×256 PNG header plus random bytes is an image. */
function png(): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(256, 16);
  head.writeUInt32BE(256, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, randomBytes(300)]);
}

function https(port: number, method: string, path: string, body?: Uint8Array): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A GET /avatars path signed with this client's session (main spec §7). */
function signed(c: TextClient, hash: string): string {
  const sid = String(c.welcome.sessionId);
  const e = fileUrlExpiry(Number(c.welcome.serverTime));
  const s = createHmac('sha256', String(c.welcome.fileToken)).update(fileSignatureInput(avatarTarget(hash), sid, e)).digest('base64url');
  return `/avatars/${hash}?sid=${encodeURIComponent(sid)}&e=${e}&s=${s}`;
}

async function setup() {
  const f = await textFixture({ extraModules: [createAvatarsModule()] });
  const port = f.t.server.port;
  const dir = join(f.t.dataDir, 'avatars');
  const begin = (c: TextClient, bytes: Uint8Array) => c.request('upload.begin', { purpose: 'icon', size: bytes.length, sha256: sha(bytes) });
  const post = (token: string, bytes: Uint8Array) => https(port, 'POST', `/upload?u=${token}`, bytes);
  return { ...f, port, begin, post, files: () => (existsSync(dir) ? readdirSync(dir) : []) };
}

describe('the server icon (spec 2026-10-01-icone-do-servidor)', () => {
  it('needs MANAGE_SERVER: a plain member can neither upload nor clear it, and a revoked grant is refused', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    expect(bia.welcome.features).toContain(FEATURE_SERVER_ICON);
    expect(bia.text.serverSettings.icon).toBeNull();

    const icon = png();
    expect((await f.begin(bia, icon)).error?.code).toBe('FORBIDDEN');
    expect(await bia.fail('server.iconClear', {})).toBe('FORBIDDEN');

    // With a role that has it she may begin; losing it before the POST voids the upload.
    const { role } = await f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Gerentes', permissions: PERMISSIONS.MANAGE_SERVER });
    await f.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id] });
    const granted = await f.begin(bia, icon);
    expect(granted.ok).toBe(true);
    await f.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [] });
    const refused = await f.post((granted.d as { uploadToken: string }).uploadToken, icon);
    expect(refused.status).toBe(403);
    expect(f.files()).toEqual([]);
    expect(bia.seen('server.updated').filter((d) => d.icon !== null && d.icon !== undefined)).toEqual([]);
  });

  it("the owner's upload becomes the icon: server.updated to everyone, served by GET /avatars, in the next welcome; server.iconClear undoes it", async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const icon = png();
    const hash = sha(icon);

    const begun = await f.begin(f.owner, icon);
    expect(begun.ok).toBe(true);
    const res = await f.post((begun.d as { uploadToken: string }).uploadToken, icon);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ icon: hash });

    const updated = await bia.event<ServerInfo>('server.updated', (d) => d.icon === hash);
    expect(updated).toMatchObject({ name: expect.any(String), icon: hash });
    // Any member's session reads it, like a photo.
    const got = await https(f.port, 'GET', signed(bia, hash));
    expect(got.status).toBe(200);
    expect(got.body.equals(icon)).toBe(true);
    const cleo = await f.join({ nickname: 'Cleo' });
    expect(cleo.text.serverSettings.icon).toBe(hash);

    await f.owner.ok('server.iconClear', {});
    await bia.event<ServerInfo>('server.updated', (d) => d.icon === null);
    expect(f.files()).toEqual([]); // no one uses the file any more
    expect((await https(f.port, 'GET', signed(bia, hash))).status).toBe(404);
  });
});
