// Main's photo pieces end to end against a real server running the avatars module (Track A):
// the controller's session hook → sync → upload; another member's _avatar route → signed download.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memberSchemaClient, type Envelope, type Member } from '@ghostlink/shared';
import { createAvatarsModule } from '../../../server/src/avatars/index.js';
import { silentLogger, startServer } from '../../../server/src/index.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { FakeTcpProxy } from '../../../server/test/helpers/fakeProxy.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import { avatarUrl } from '../../src/shared/profileTypes.js';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';
import { createAvatars, type Avatars } from '../../src/main/avatars/index.js';
import { ClientController, type ActiveSession } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';
import { gif, sha256Hex, webp } from './avatarFixtures.js';

const tmp = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', modules: [createTextModule(), createAvatarsModule()], ...opts });
  cleanups.push(() => t.cleanup());
  return t;
}

interface Client {
  name: string;
  dir: string;
  controller: ClientController;
  avatars: Avatars;
  events: Envelope[];
  /** Request types main sent over the session (a spy around ActiveSession.request). */
  sent: string[];
  warnings: string[];
  sessions: Array<ActiveSession | null>;
  join(address: string, t: TestServer): Promise<RendererWelcome>;
  photo(hash: string): Promise<Response>;
}

function client(name: string): Client {
  const dir = join(tmp.path, name);
  mkdirSync(dir);
  const identity = IdentityStore.load(dir, new FakeSafeStorage());
  identity.create();
  const events: Envelope[] = [];
  const sent: string[] = [];
  const warnings: string[] = [];
  const sessions: Array<ActiveSession | null> = [];
  const avatars = createAvatars({ userDataDir: dir, warn: (m) => warnings.push(m), http: { timeoutMs: 10_000 } });
  const controller = new ClientController({
    identity,
    settings: SettingsStore.load(dir, 'pt-BR'),
    servers: SavedServersStore.load(dir),
    setRendererPins: async () => {},
    emitConnectionState: () => {},
    emitServerEvent: (e) => events.push(e),
    clientName: 'ghostlink/0.2.2 (test)',
    connectionOptions: { timing: { backoffMinMs: 50, backoffMaxMs: 200 }, random: () => 0.5 },
    onSession: (s) => {
      sessions.push(s);
      avatars.onSession(
        s && {
          ...s,
          request: <T>(t: string, d?: unknown) => {
            sent.push(t);
            return s.request<T>(t, d);
          },
        },
      );
    },
  });
  cleanups.push(async () => {
    await controller.disconnect();
    await avatars.idle();
  });
  return {
    name,
    dir,
    controller,
    avatars,
    events,
    sent,
    warnings,
    sessions,
    join: (address, t) => controller.join({ addresses: [address], serverKeyId: t.server.serverKeyId, nickname: name }),
    photo: (hash) => avatars.route(new Request(avatarUrl(hash))),
  };
}

const local = (t: TestServer) => `127.0.0.1:${t.server.port}`;

function memberIn(welcome: unknown, userId: string): Member | undefined {
  const members = (welcome as { members?: unknown[] }).members ?? [];
  return members.map((m) => memberSchemaClient.parse(m)).find((m) => m.userId === userId);
}

/** The last member.updated `c` saw for `userId`. */
function lastUpdate(c: Client, userId: string): Member | undefined {
  return c.events
    .filter((e) => e.t === 'member.updated')
    .map((e) => memberSchemaClient.parse((e.d as { member: unknown }).member))
    .filter((m) => m.userId === userId)
    .at(-1);
}

const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('profile photos against a real server (spec 2026-10-01 §4)', () => {
  it('uploads my photo after the welcome; another member gets it through the _avatar route', async () => {
    const t = await server();
    const ana = client('Ana');
    const bytes = webp(256, 256, { size: 4000 });
    const info = await ana.avatars.profile.setAvatar(bytes);
    const welcome = await ana.join(local(t), t);
    await ana.avatars.idle();
    expect(ana.sent).toEqual(['upload.begin']);
    expect(ana.warnings).toEqual([]);

    const bia = client('Bia');
    const biaWelcome = await bia.join(local(t), t);
    expect(memberIn(biaWelcome, welcome.self.userId)?.avatar).toBe(info.hash);
    const res = await bia.photo(info.hash);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(await bodyOf(res)).toEqual(bytes);
    expect(existsSync(join(bia.dir, 'avatars', info.hash))).toBe(true);
    expect(bia.warnings).toEqual([]);

    const mine = await ana.photo(info.hash); // mine, from the store
    expect(await bodyOf(mine)).toEqual(bytes);
  });

  it('a change while connected reaches everyone; removing it brings the initials back', async () => {
    const t = await server();
    const ana = client('Ana');
    const bia = client('Bia');
    const { self } = await ana.join(local(t), t);
    await bia.join(local(t), t);
    await ana.avatars.idle();
    expect(ana.sent).toEqual([]); // no photo on either side: nothing to do

    const bytes = gif(256, 256, { size: 20_000 });
    const info = await ana.avatars.profile.setAvatar(bytes);
    await ana.avatars.idle();
    await waitFor(() => lastUpdate(bia, self.userId)?.avatar === info.hash);
    expect(await bodyOf(await bia.photo(info.hash))).toEqual(bytes);

    await ana.avatars.profile.clearAvatar();
    await ana.avatars.idle();
    await waitFor(() => lastUpdate(bia, self.userId)?.avatar === null);
    expect(ana.sent).toEqual(['upload.begin', 'avatar.clear']);
  });

  it('sends nothing again after a reconnect when the server already has my photo', async () => {
    const t = await server();
    const ana = client('Ana');
    const info = await ana.avatars.profile.setAvatar(webp());
    await ana.join(local(t), t);
    await ana.avatars.idle();
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger, joinMode: 'open', modules: [createTextModule(), createAvatarsModule()] });
    cleanups.push(() => again.close());
    await waitFor(() => ana.sessions.length >= 3 && ana.sessions.at(-1) !== null, 10_000); // welcome, null, welcome
    await ana.avatars.idle();
    expect(memberIn(ana.sessions.at(-1)!.welcome, ana.sessions.at(-1)!.welcome.self.userId)?.avatar).toBe(info.hash);
    expect(ana.sent).toEqual(['upload.begin']);
  });

  it('clears the photo on a server that kept it while I removed it offline', async () => {
    const t = await server();
    const ana = client('Ana');
    await ana.avatars.profile.setAvatar(webp());
    const first = await ana.join(local(t), t);
    await ana.avatars.idle();
    await ana.controller.disconnect();
    await ana.avatars.profile.clearAvatar(); // not connected: stored only
    await ana.avatars.idle();
    expect(ana.sent).toEqual(['upload.begin']);
    await ana.controller.connectSaved(first.serverId);
    await ana.avatars.idle();
    expect(ana.sent).toEqual(['upload.begin', 'avatar.clear']);
    const bia = client('Bia');
    expect(memberIn(await bia.join(local(t), t), first.self.userId)?.avatar).toBeNull();
  });

  it('leaves a server without the avatars module alone, and never asks it for photos', async () => {
    const t = await server({ modules: [createTextModule()] });
    const ana = client('Ana');
    await ana.avatars.profile.setAvatar(webp());
    await ana.join(local(t), t);
    await ana.avatars.idle();
    expect(ana.sent).toEqual([]);
    expect((await ana.photo(sha256Hex(gif()))).status).toBe(404);
    expect(ana.warnings).toEqual([]);
  });

  it('answers 404 for a photo the server does not have, without a warning', async () => {
    const t = await server();
    const ana = client('Ana');
    await ana.join(local(t), t);
    expect((await ana.photo(sha256Hex(gif()))).status).toBe(404);
    expect(ana.warnings).toEqual([]);
  });

  it('works the same behind a TCP proxy (Railway)', async () => {
    const t = await server({ proxy: { host: 'proxy.example.net', port: 25_889 } });
    const proxy = await new FakeTcpProxy(t.server.port).listen();
    cleanups.push(() => proxy.close());
    const ana = client('Ana');
    const bia = client('Bia');
    const bytes = webp(256, 256, { size: 3000 });
    const info = await ana.avatars.profile.setAvatar(bytes);
    const { self } = await ana.join(`127.0.0.1:${proxy.port}`, t);
    await ana.avatars.idle();
    expect(ana.warnings).toEqual([]);
    const biaWelcome = await bia.join(`127.0.0.1:${proxy.port}`, t);
    expect(memberIn(biaWelcome, self.userId)?.avatar).toBe(info.hash);
    const before = proxy.tlsConnections.length;
    expect(await bodyOf(await bia.photo(info.hash))).toEqual(bytes);
    expect(proxy.tlsConnections.length).toBe(before + 1); // the download went through the proxy
  });
});
