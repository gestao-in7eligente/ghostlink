import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJoinInput } from '@ghostlink/shared';
import { silentLogger, startServer } from '../../src/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  cleanups.push(() => t.cleanup());
  return t;
}

async function client(t: TestServer, opts: Parameters<typeof connectTestClient>[1]): Promise<TestClient> {
  const c = await connectTestClient(t.server, opts);
  cleanups.push(() => c.close());
  return c;
}

describe('GhostServer host-control seams (spec §9)', () => {
  it('seeds max_members on the first run only, like the name and join mode', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const first = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Casa', joinMode: 'open', maxMembers: 12 });
    expect(first.info()).toMatchObject({ name: 'Casa', joinMode: 'open', maxMembers: 12, members: 0, hasOwner: false, publicAddresses: [] });
    await first.close();

    const again = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Outro', joinMode: 'invite', maxMembers: 50 });
    expect(again.info()).toMatchObject({ name: 'Casa', joinMode: 'open', maxMembers: 12 });
    await again.close();
  });

  it('refuses an invalid member limit before touching the data dir', async () => {
    for (const maxMembers of [0, -1, 1.5, 100_001, Number.NaN]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
      await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, maxMembers }), String(maxMembers)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(existsSync(join(dataDir, 'ghostlink.db'))).toBe(false);
    }
  });

  it('info() counts members and reports the owner once the setup code is used', async () => {
    const t = await server();
    const owner = await client(t, { nickname: 'Dona', setupCode: t.server.setupCode()! });
    expect(owner.welcome?.self.isOwner).toBe(true);
    expect(t.server.info()).toMatchObject({ members: 1, hasOwner: true, joinMode: 'invite', maxMembers: 100 });
  });

  it('setPublicAddresses() canonicalizes, deduplicates and feeds new invites', async () => {
    const t = await server();
    t.server.setPublicAddresses(['192.168.0.10:7700', '192.168.0.10:7700', '[::1]:7700', 'Example.COM:7710']);
    const expected = ['192.168.0.10:7700', '[::1]:7700', 'example.com:7710'];
    expect(t.server.info().publicAddresses).toEqual(expected);
    const parsed = parseJoinInput(t.server.createInvite().pasteCode);
    expect(parsed.kind === 'invite' && parsed.invite.addresses).toEqual(expected);
    expect(() => t.server.setPublicAddresses(['not an address'])).toThrow();
    expect(() => t.server.setPublicAddresses(Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}:7700`))).toThrow();
    expect(t.server.info().publicAddresses).toEqual(expected);
  });

  it('resetSetupCode() ("Recuperar posse") issues a new code that makes an existing member the owner', async () => {
    const t = await server({ joinMode: 'open' });
    const first = t.server.setupCode()!;
    const memberSeed = randomBytes(32);
    expect((await client(t, { nickname: 'Dona', setupCode: first })).welcome?.self.isOwner).toBe(true);
    const member = await client(t, { nickname: 'Bia', seed: memberSeed });
    expect(member.welcome?.self.isOwner).toBe(false);
    member.close();

    const fresh = t.server.resetSetupCode();
    expect(fresh).not.toBe(first);
    expect(readFileSync(join(t.dataDir, 'setup-code.txt'), 'utf8').trim()).toBe(fresh);
    expect(t.server.setupCode()).toBe(fresh);
    const again = await client(t, { nickname: 'Bia', seed: memberSeed, setupCode: fresh });
    expect(again.welcome?.self.isOwner).toBe(true);
    expect(existsSync(join(t.dataDir, 'setup-code.txt'))).toBe(false);
    expect(t.server.setupCode()).toBeNull();
  });
});
