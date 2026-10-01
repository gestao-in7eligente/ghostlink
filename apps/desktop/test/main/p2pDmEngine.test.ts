import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import type { DmEvent, DmMessage } from '../../src/shared/dmTypes.js';
import { IdentityStore } from '../../src/main/identity.js';
import { dmConversationId } from '../../src/main/p2p/conversations.js';
import type { DmNotification } from '../../src/main/p2p/dm.js';
import { FriendsEngine, type FriendsEngineDeps } from '../../src/main/p2p/engine.js';
import { entryBodyJson, signEntry } from '../../src/main/p2p/entries.js';
import { encodeMessage } from '../../src/main/p2p/frames.js';
import { encodeFriendCode } from '../../src/main/p2p/friendCode.js';
import { friendKeyFromSeed, keyFromText, keyToText } from '../../src/main/p2p/friendKey.js';
import { FriendSwarm, type FriendLink } from '../../src/main/p2p/swarm.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  return undefined;
}

let testnet: Testnet;
const engines: FriendsEngine[] = [];
const nodes: FriendSwarm[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterAll(async () => {
  await testnet.destroy();
});

/** One installation over the loopback DHT, recording what main would send the renderer. */
function app(name: string, opts: { identity?: boolean; deps?: Partial<FriendsEngineDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-dm-engine-'));
  dirs.push(dir);
  const identity = IdentityStore.load(dir, new FakeSafeStorage());
  if (opts.identity !== false) identity.create();
  const events: DmEvent[] = [];
  const notes: DmNotification[] = [];
  const boot = () => {
    const engine = new FriendsEngine({
      identity,
      settings: { get: () => ({ locale: 'en' as const, nickname: name }) },
      userDataDir: dir,
      emit: () => {},
      emitDm: (event) => events.push(event),
      notifyDm: (note) => notes.push(note),
      bootstrap: testnet.bootstrap,
      bindHost: '127.0.0.1',
      retryDelayMs: () => 150,
      ...opts.deps,
    });
    engines.push(engine);
    return engine;
  };
  let engine = boot();
  const self = {
    events,
    notes,
    get engine() {
      return engine;
    },
    get dm() {
      return engine.dm;
    },
    async start() {
      await engine.sync();
      return self;
    },
    async restart() {
      await engine.dispose();
      engine = boot();
      await engine.sync();
    },
    async code(): Promise<string> {
      return (await engine.state()).code!;
    },
    async key(): Promise<string> {
      return keyToText(friendKeyFromSeed(identity.friendSeed()).publicKey);
    },
    async online(other: { key(): Promise<string> }): Promise<boolean> {
      const key = await other.key();
      return (await engine.state()).friends.some((f) => f.key === key && f.state === 'friend' && f.online);
    },
    async texts(conv: string): Promise<string[]> {
      return (await engine.dm.history(conv, null, 200)).map((m) => m.text);
    },
    async history(conv: string): Promise<DmMessage[]> {
      return engine.dm.history(conv, null, 200);
    },
  };
  return self;
}
type App = ReturnType<typeof app>;

async function befriend(a: App, b: App): Promise<void> {
  await a.engine.add(await b.code());
  await until(async () => (await b.engine.state()).friends.some((f) => f.state === 'pending_in'));
  await b.engine.accept(await a.key());
  await until(async () => (await a.online(b)) && (await b.online(a)));
}

/** Ana and Bia, friends and online, with the conversation open on Ana's side. */
async function pair() {
  const ana = await app('Ana').start();
  const bia = await app('Bia').start();
  await befriend(ana, bia);
  const conv = (await ana.dm.open(await bia.key())).id;
  return { ana, bia, conv };
}

describe('direct messages between two engines over a loopback DHT (friends spec §4, §11)', () => {
  it('delivers at once both ways, and marks them delivered', async () => {
    const { ana, bia, conv } = await pair();
    expect(conv).toBe(dmConversationId(keyFromText(await ana.key()), keyFromText(await bia.key())));
    const sent = await ana.dm.send(conv, 'oi, Bia', null);
    expect(sent).toMatchObject({ conv, mine: true, text: 'oi, Bia', delivered: false });
    await until(async () => (await bia.dm.conversations()).length === 1);
    expect(await bia.dm.conversations()).toEqual([{ id: conv, kind: 'dm', peer: await ana.key(), lastTs: sent.ts, lastText: 'oi, Bia', unread: 1, hidden: false }]);
    expect(await bia.texts(conv)).toEqual(['oi, Bia']);
    await until(async () => (await ana.history(conv))[0]!.delivered);
    expect(ana.events).toContainEqual({ type: 'message', message: { ...sent, delivered: true } });

    const answer = await bia.dm.send(conv, 'oi, Ana!', sent.id);
    await until(async () => (await ana.texts(conv)).length === 2);
    expect((await ana.history(conv))[1]).toMatchObject({ id: answer.id, mine: false, replyTo: sent.id, delivered: true });
    await until(async () => (await bia.history(conv)).every((m) => m.delivered));
    // Bia's app was told, and would have shown a notification (a moment later, once per burst).
    await until(() => bia.notes.length > 0);
    expect(bia.notes).toEqual([{ conv, title: 'Ana', body: 'oi, Bia' }]);
    expect(bia.events.some((e) => e.type === 'message' && e.message.id === sent.id)).toBe(true);
  });

  it('keeps messages while the friend is offline and delivers them in order when they come back', async () => {
    const { ana, bia, conv } = await pair();
    await bia.engine.dispose();
    await until(async () => !(await ana.online(bia)));
    for (const text of ['um', 'dois', 'três']) await ana.dm.send(conv, text, null);
    await pause(500);
    expect((await ana.history(conv)).map((m) => m.delivered)).toEqual([false, false, false]);

    await bia.restart();
    await until(async () => (await bia.dm.conversations()).length === 1 && (await bia.texts(conv)).length === 3, 20_000);
    expect(await bia.texts(conv)).toEqual(['um', 'dois', 'três']);
    await until(async () => (await ana.history(conv)).every((m) => m.delivered));
  }, 40_000);

  it('edit and delete reach the other side', async () => {
    const { ana, bia, conv } = await pair();
    const sent = await ana.dm.send(conv, 'oi', null);
    await until(async () => (await bia.texts(conv).catch(() => [])).length === 1);
    await ana.dm.edit(conv, sent.id, 'oi!');
    await until(async () => (await bia.history(conv))[0]!.text === 'oi!');
    expect((await bia.history(conv))[0]!.editedAt).not.toBeNull();
    await ana.dm.remove(conv, sent.id);
    await until(async () => (await bia.history(conv))[0]!.deleted);
    expect((await bia.history(conv))[0]).toMatchObject({ text: '', deleted: true });
    expect(await codeOf(bia.dm.edit(conv, sent.id, 'x'))).toBe('NOT_FOUND');
    expect(await codeOf(bia.dm.remove(conv, sent.id))).toBe('FORBIDDEN');
  });

  it('throttles typing to one signal every 3 s', async () => {
    const { ana, bia, conv } = await pair();
    await bia.dm.open(await ana.key());
    for (let i = 0; i < 5; i++) await ana.dm.typing(conv);
    await until(() => bia.events.some((e) => e.type === 'typing'));
    await pause(500);
    expect(bia.events.filter((e) => e.type === 'typing')).toEqual([{ type: 'typing', conv, author: await ana.key() }]);
  });

  it('refuses the entries of someone who is not a friend', async () => {
    const ana = await app('Ana').start();
    const evaKey = friendKeyFromSeed(createHash('sha256').update('eva').digest());
    const eva = await FriendSwarm.start({ seed: createHash('sha256').update('eva').digest(), allow: () => true, bootstrap: testnet.bootstrap, bindHost: '127.0.0.1' });
    nodes.push(eva);
    const anaKey = keyFromText(await ana.key());
    // Ana asked Eva (a code with Eva's key), so her firewall lets Eva in; Eva is no friend yet.
    await ana.engine.add(encodeFriendCode(evaKey.publicKey, randomBytes(16)));
    const conv = dmConversationId(anaKey, evaKey.publicKey);
    let link: FriendLink | null = null;
    eva.onLink((l) => {
      link = l;
      l.send(encodeMessage({ t: 'hello', v: 1, nickname: 'Eva' }));
      const body = entryBodyJson({ kind: 'msg', id: 'ab'.repeat(16), text: 'me adiciona', replyTo: null });
      l.send(encodeMessage({ t: 'entry', entry: signEntry(evaKey, { conv, seq: 1, ts: Date.now(), kind: 'msg', body }) }));
      l.send(encodeMessage({ t: 'sync.have', convs: [{ id: conv, heads: { [keyToText(evaKey.publicKey)]: 1 } }] }));
    });
    eva.connectTo(anaKey);
    await until(() => link !== null);
    await pause(1_000);
    expect(await ana.dm.conversations()).toEqual([]);
    expect(ana.events).toEqual([]);
    expect(await codeOf(ana.dm.open(keyToText(evaKey.publicKey)))).toBe('FORBIDDEN');
  });

  it("a removed friend's link no longer syncs; the history stays readable and writing is refused", async () => {
    const { ana, bia, conv } = await pair();
    await ana.dm.send(conv, 'oi', null);
    await until(async () => (await bia.texts(conv).catch(() => [])).length === 1);
    await bia.engine.dispose();
    await ana.engine.remove(await bia.key()); // the goodbye never reaches Bia

    await bia.restart();
    // Bia still counts Ana as a friend and writes; Ana's firewall keeps her out.
    await bia.dm.send(conv, 'oi?', null);
    await pause(2_500);
    expect(await ana.texts(conv)).toEqual(['oi']);
    expect((await bia.history(conv)).at(-1)).toMatchObject({ text: 'oi?', delivered: false });
    expect(await codeOf(ana.dm.send(conv, 'tchau', null))).toBe('FORBIDDEN');
    expect((await ana.dm.conversations()).map((c) => c.id)).toEqual([conv]);
  }, 40_000);

  it('reads offline, and refuses what needs the network with P2P_UNAVAILABLE', async () => {
    const { ana, bia, conv } = await pair();
    const sent = await ana.dm.send(conv, 'oi', null);
    await ana.engine.setAvailable(false);
    expect(await ana.texts(conv)).toEqual(['oi']);
    expect((await ana.dm.conversations()).map((c) => c.id)).toEqual([conv]);
    await ana.dm.read(conv, Date.now());
    await ana.dm.hide(conv);
    for (const call of [
      ana.dm.send(conv, 'x', null),
      ana.dm.edit(conv, sent.id, 'x'),
      ana.dm.remove(conv, sent.id),
      ana.dm.typing(conv),
      ana.dm.open(await bia.key()),
    ]) {
      expect(await codeOf(call)).toBe('P2P_UNAVAILABLE');
    }
  });

  it('without an identity: no conversations, and the rest says P2P_UNAVAILABLE', async () => {
    const ana = await app('Ana', { identity: false }).start();
    const conv = 'ab'.repeat(16);
    expect(await ana.dm.conversations()).toEqual([]);
    expect(await codeOf(ana.dm.history(conv, null, 50))).toBe('P2P_UNAVAILABLE');
    expect(await codeOf(ana.dm.read(conv, 1))).toBe('P2P_UNAVAILABLE');
    expect(await codeOf(ana.dm.send(conv, 'x', null))).toBe('P2P_UNAVAILABLE');
  });

  it('keeps the conversation across a restart and syncs what was missed', async () => {
    const { ana, bia, conv } = await pair();
    await ana.dm.send(conv, 'um', null);
    await until(async () => (await bia.texts(conv).catch(() => [])).length === 1);
    await ana.engine.dispose();
    await bia.dm.send(conv, 'dois', null);
    await ana.restart();
    await until(async () => (await ana.texts(conv)).length === 2, 20_000);
    expect(await ana.texts(conv)).toEqual(['um', 'dois']);
    expect((await ana.dm.conversations())[0]!.unread).toBe(1);
  }, 40_000);
});
