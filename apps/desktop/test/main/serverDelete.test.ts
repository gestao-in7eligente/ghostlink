// Leaving and deleting a server from the app's main process (leave/delete spec §2, §3), against a
// real server with a test clock: Ana owns it, Bia is a member.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_DELETE_LIMITS } from '@ghostlink/shared';
import { createServerDeleteModule } from '../../../server/src/deletion/index.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import type { ConnectionStateEvent } from '../../src/shared/ipcTypes.js';
import { ClientController, type DeletionUpdate } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { deadPort, waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Person {
  controller: ClientController;
  servers: SavedServersStore;
  states: ConnectionStateEvent[];
  deletions: DeletionUpdate[];
}

function person(name: string): Person {
  const home = join(dir.path, name);
  mkdirSync(home, { recursive: true });
  const identity = IdentityStore.load(home, new FakeSafeStorage());
  identity.create();
  const servers = SavedServersStore.load(home);
  const states: ConnectionStateEvent[] = [];
  const deletions: DeletionUpdate[] = [];
  const controller = new ClientController({
    identity,
    settings: SettingsStore.load(home, 'pt-BR'),
    servers,
    setRendererPins: async () => {},
    emitConnectionState: (e) => states.push(e),
    emitServerEvent: () => {},
    clientName: 'ghostlink/0.2.4 (test)',
    connectionOptions: { timing: { backoffMinMs: 50, backoffMaxMs: 200 }, random: () => 0.5 },
    onDeletion: (u) => deletions.push(u),
  });
  cleanups.push(() => controller.disconnect());
  return { controller, servers, states, deletions };
}

const clock = { now: Date.UTC(2026, 9, 1, 12) };
let t: TestServer;
let ana: Person;
let bia: Person;

beforeEach(async () => {
  clock.now = Date.UTC(2026, 9, 1, 12);
  t = await startTestServer({ name: 'Tropa do ADS', joinMode: 'open', now: () => clock.now, modules: [createTextModule(), createServerDeleteModule()] });
  cleanups.push(() => t.cleanup());
  ana = person('ana');
  bia = person('bia');
  const address = `127.0.0.1:${t.server.port}`;
  await ana.controller.join({ addresses: [address], serverKeyId: t.server.serverKeyId, nickname: 'Ana', setupCode: t.server.setupCode()! });
  await bia.controller.join({ addresses: [address], serverKeyId: t.server.serverKeyId, nickname: 'Bia' });
});

const savedId = (p: Person) => p.servers.list()[0]!.id;

describe('checkExit: what "Sair do servidor" offers', () => {
  it('a member leaves; the owner deletes (the open server answers from its own session)', async () => {
    await bia.controller.disconnect();
    expect(await bia.controller.checkExit(savedId(bia))).toEqual({ kind: 'member' });
    expect(await ana.controller.checkExit(savedId(ana))).toEqual({ kind: 'owner', name: 'Tropa do ADS', canDelete: true, deletingAt: null });
  });

  it('a server that does not answer offers "Tirar só da minha lista"', async () => {
    const lost = bia.servers.upsert({ serverKeyId: 'k'.repeat(43), name: 'Sumido', addresses: [`127.0.0.1:${await deadPort()}`], nickname: 'Bia' });
    expect(await bia.controller.checkExit(lost.id)).toEqual({ kind: 'unreachable', code: 'UNREACHABLE' });
  });
});

describe('leaveSaved', () => {
  it('a member leaves through a short connection and the server leaves the list', async () => {
    await bia.controller.disconnect();
    await bia.controller.leaveSaved(savedId(bia), true);
    expect(bia.servers.list()).toEqual([]);
    expect(t.server.info().members).toBe(1);
  });

  it('the owner cannot leave', async () => {
    await expect(ana.controller.leaveSaved(savedId(ana), false)).rejects.toMatchObject({ code: 'OWNER_MUST_TRANSFER' });
    expect(ana.servers.list()).toHaveLength(1);
  });
});

describe('deleteSaved (spec §3)', () => {
  it('takes Bia out at once with the date, refuses her, and Ana restores it', async () => {
    const at = clock.now + SERVER_DELETE_LIMITS.graceMs;
    expect(await ana.controller.deleteSaved(savedId(ana))).toEqual({ at });
    // Ana's app records the deadline in its own clock (the test server shares it).
    await waitFor(() => ana.deletions.some((d) => d.kind === 'deleting'));
    const recorded = ana.deletions.find((d) => d.kind === 'deleting') as Extract<DeletionUpdate, { kind: 'deleting' }>;
    expect(Math.abs(recorded.at - (at - (clock.now - Date.now())))).toBeLessThan(5_000);
    expect(ana.controller.session).not.toBeNull(); // the owner stays

    await waitFor(() => bia.states.some((s) => s.state === 'failed'));
    expect(bia.states.at(-1)).toEqual({ state: 'failed', serverId: savedId(bia), error: 'SERVER_DELETING', deletingAt: at });
    expect(bia.deletions).toEqual([]); // a member's app never records an owner's deletion
    expect(await bia.controller.checkExit(savedId(bia))).toEqual({ kind: 'deleting', at });
    await expect(bia.controller.connectSaved(savedId(bia))).rejects.toMatchObject({ code: 'SERVER_DELETING' });
    expect(bia.states.at(-1)).toMatchObject({ state: 'failed', error: 'SERVER_DELETING', deletingAt: at });
    expect(bia.servers.list()).toHaveLength(1); // still restorable: the list keeps it

    await ana.controller.request('server.restore', {});
    await waitFor(() => ana.deletions.at(-1)?.kind === 'restored');
    await expect(bia.controller.connectSaved(savedId(bia))).resolves.toMatchObject({ server: { name: 'Tropa do ADS' } });
  });

  it('after the deadline Bia reads SERVER_DELETED and the server leaves her list', async () => {
    await ana.controller.deleteSaved(savedId(ana));
    await waitFor(() => bia.states.some((s) => s.state === 'failed'));
    clock.now += SERVER_DELETE_LIMITS.graceMs + 1;
    expect(await bia.controller.checkExit(savedId(bia))).toEqual({ kind: 'deleted' });
    expect(bia.servers.list()).toEqual([]);
    expect(bia.deletions).toEqual([{ kind: 'deleted', serverKeyId: t.server.serverKeyId }]);
  });

  it('only the owner deletes', async () => {
    await expect(bia.controller.deleteSaved(savedId(bia))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
