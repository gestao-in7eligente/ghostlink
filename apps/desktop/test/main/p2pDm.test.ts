import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { DM_TEXT_MAX, type DmConversation, type DmEvent, type DmMessage } from '../../src/shared/dmTypes.js';
import { dmConversationId } from '../../src/main/p2p/conversations.js';
import { Dm, NOTIFY_DELAY_MS, TYPING_INTERVAL_MS, type DmNotification } from '../../src/main/p2p/dm.js';
import { ENTRY_MAX_FUTURE_MS, entryBodyJson, signEntry, type Entry, type EntryBody } from '../../src/main/p2p/entries.js';
import { encodeMessage, type P2pMessage } from '../../src/main/p2p/frames.js';
import { encodeFriendCode } from '../../src/main/p2p/friendCode.js';
import { friendKeyFromSeed, keyToText, type FriendKey } from '../../src/main/p2p/friendKey.js';
import { Friends } from '../../src/main/p2p/friends.js';
import { FriendsStore } from '../../src/main/p2p/store.js';
import { ACK_DELAY_MS, WANT_MAX } from '../../src/main/p2p/sync.js';
import { FakeWorld, ManualTimers, flush, hexOf, linkPair, type FakeLink } from '../helpers/p2pFakes.js';

const dirs: string[] = [];
const stores: FriendsStore[] = [];
const dms: Dm[] = [];
afterEach(() => {
  for (const dm of dms.splice(0)) dm.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  return undefined;
}

const keyOf = (name: string): FriendKey => friendKeyFromSeed(createHash('sha256').update(name).digest());

/** A world with one clock; every person has a friend key, a database, the friendship rules and the DM rules. */
function setup() {
  const world = new FakeWorld();
  const timers = new ManualTimers();
  const person = (name: string) => {
    const signer = keyOf(name);
    const dir = mkdtempSync(join(tmpdir(), 'ghostlink-dm-'));
    dirs.push(dir);
    const store = FriendsStore.open(dir, signer.publicKey);
    stores.push(store);
    const events: DmEvent[] = [];
    const notes: DmNotification[] = [];
    const create = () => {
      const dm = new Dm({ store, key: signer, emit: (e) => events.push(e), notify: (n) => notes.push(n), now: () => timers.now, timers });
      dms.push(dm);
      const friends = new Friends({ store, key: signer, nickname: () => name, onChange: () => {}, now: () => timers.now, timers, traffic: dm });
      return { dm, friends };
    };
    let parts = create();
    const node = world.node(signer.publicKey, (remote) => parts.friends.allows(remote));
    const self = {
      name,
      key: signer.publicKey,
      signer,
      store,
      node,
      events,
      notes,
      get dm() {
        return parts.dm;
      },
      get friends() {
        return parts.friends;
      },
      start() {
        node.online = true;
        parts.friends.attach(node);
        return self;
      },
      /** The app closes: every link drops; a later start() is a fresh process over the same database. */
      quit() {
        parts.friends.detach();
        parts.dm.dispose();
        node.goOffline();
        node.wanted.clear();
        node.inbox = null;
        parts = create();
      },
      conv(other: { key: Uint8Array }): string {
        return dmConversationId(signer.publicKey, other.key);
      },
      texts(other: { key: Uint8Array }): string[] {
        return parts.dm.history(self.conv(other), null, 200).map((m) => m.text);
      },
      summary(other: { key: Uint8Array }): DmConversation | undefined {
        return parts.dm.conversations().find((c) => c.id === self.conv(other));
      },
      /** The message events, newest last. */
      messageEvents(): DmMessage[] {
        return events.flatMap((e) => (e.type === 'message' ? [e.message] : []));
      },
      conversationEvents(): DmConversation[] {
        return events.flatMap((e) => (e.type === 'conversation' ? [e.conversation] : []));
      },
    };
    return self;
  };
  return { world, timers, person };
}
type Person = ReturnType<ReturnType<typeof setup>['person']>;

/** Two friends, both online. */
async function friendsAlready() {
  const s = setup();
  const ana = s.person('Ana').start();
  const bia = s.person('Bia').start();
  ana.friends.add(bia.friends.code());
  await flush();
  bia.friends.accept(ana.key);
  await s.world.settle();
  expect(ana.friends.list()[0]).toMatchObject({ state: 'friend', online: true });
  return { ...s, ana, bia };
}

/** A friend link opened by hand into `person`; the test plays the other end. */
function rawLink(person: Person, remoteKey: Uint8Array): FakeLink {
  for (const link of [...person.node.links.values()]) link.close();
  const [theirs, mine] = linkPair(person.key, remoteKey);
  for (const listener of person.node.listeners) listener(theirs);
  return mine;
}
const say = (link: FakeLink, message: P2pMessage) => link.send(encodeMessage(message));
/** What `person` sent on a raw link. */
const heard = (link: FakeLink) => link.peer.messages;

function entryOf(signer: FriendKey, conv: string, seq: number, body: EntryBody, ts: number): Entry {
  return signEntry(signer, { conv, seq, ts, kind: body.kind, body: entryBodyJson(body) });
}
const msg = (n: number, text = `m${n}`): EntryBody => ({ kind: 'msg', id: n.toString(16).padStart(32, '0'), text, replyTo: null, attachments: [] });

describe('opening a conversation (friends spec §4.1, §8)', () => {
  it('needs a friend: strangers, requests and blocked people are FORBIDDEN', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const cleo = person('Cleo');
    const dora = person('Dora').start();
    expect(codeOf(() => ana.dm.open(randomBytes(32)))).toBe('FORBIDDEN');
    expect(codeOf(() => ana.dm.open(ana.key))).toBe('FORBIDDEN');
    ana.friends.add(cleo.friends.code());
    expect(codeOf(() => ana.dm.open(cleo.key))).toBe('FORBIDDEN');
    dora.friends.add(ana.friends.code());
    await flush();
    expect(codeOf(() => ana.dm.open(dora.key))).toBe('FORBIDDEN');
    ana.friends.block(dora.key);
    expect(codeOf(() => ana.dm.open(dora.key))).toBe('FORBIDDEN');
    expect(ana.dm.conversations()).toEqual([]);
  });

  it('creates the conversation once, with the id both sides compute, and shows it again when hidden', async () => {
    const { ana, bia } = await friendsAlready();
    const opened = ana.dm.open(bia.key);
    expect(opened).toEqual({ id: bia.conv(ana), kind: 'dm', peer: keyToText(bia.key), lastTs: null, lastText: null, unread: 0, hidden: false });
    expect(ana.conversationEvents()).toEqual([opened]);
    expect(ana.dm.open(bia.key)).toEqual(opened);
    expect(ana.conversationEvents()).toHaveLength(1);

    ana.dm.hide(opened.id);
    expect(ana.conversationEvents().at(-1)).toEqual({ ...opened, hidden: true });
    expect(ana.dm.conversations()).toEqual([{ ...opened, hidden: true }]);
    ana.dm.hide(opened.id);
    expect(ana.conversationEvents()).toHaveLength(2);
    expect(ana.dm.open(bia.key)).toEqual(opened);
    expect(ana.conversationEvents().at(-1)).toEqual(opened);
    // An empty conversation is nobody's business: Bia has nothing yet.
    expect(bia.dm.conversations()).toEqual([]);
  });

  it('answers NOT_FOUND for a conversation it does not have', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.conv(bia);
    const id = 'ab'.repeat(16);
    for (const call of [
      () => ana.dm.hide(conv),
      () => ana.dm.history(conv, null, 50),
      () => ana.dm.send(conv, 'oi', null),
      () => ana.dm.edit(conv, id, 'oi'),
      () => ana.dm.remove(conv, id),
      () => ana.dm.read(conv, 1),
      () => ana.dm.typing(conv),
    ]) {
      expect(codeOf(call)).toBe('NOT_FOUND');
    }
  });
});

describe('sending (friends spec §4.2, §4.3)', () => {
  it('delivers at once to a friend online, both ways', async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const sent = ana.dm.send(conv, 'oi, Bia', null);
    expect(sent).toMatchObject({ conv, author: keyToText(ana.key), mine: true, ts: timers.now, text: 'oi, Bia', replyTo: null, editedAt: null, deleted: false, delivered: false });
    expect(sent.id).toMatch(/^[0-9a-f]{32}$/);
    // Ana's own events come before the call returns, for the renderer to merge by id.
    expect(ana.messageEvents()).toEqual([sent]);
    expect(ana.summary(bia)).toMatchObject({ lastTs: sent.ts, lastText: 'oi, Bia', unread: 0 });

    expect(bia.texts(ana)).toEqual(['oi, Bia']);
    expect(bia.messageEvents()).toEqual([{ ...sent, mine: false, delivered: true }]);
    expect(bia.conversationEvents().at(-1)).toEqual({ id: conv, kind: 'dm', peer: keyToText(ana.key), lastTs: sent.ts, lastText: 'oi, Bia', unread: 1, hidden: false });

    await timers.advance(1_000);
    const answer = bia.dm.send(conv, 'oi, Ana!', sent.id);
    expect(ana.dm.history(conv, null, 50).map((m) => [m.text, m.replyTo, m.mine])).toEqual([['oi, Bia', null, true], ['oi, Ana!', sent.id, false]]);
    expect(ana.messageEvents().at(-1)).toEqual({ ...answer, mine: false, delivered: true });
  });

  it("marks own messages delivered once the friend's sync.have covers them", async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const sent = ana.dm.send(conv, 'oi', null);
    expect(ana.dm.history(conv, null, 50)[0]!.delivered).toBe(false);
    await timers.advance(ACK_DELAY_MS);
    expect(ana.messageEvents().at(-1)).toEqual({ ...sent, delivered: true });
    expect(ana.dm.history(conv, null, 50)[0]!.delivered).toBe(true);
    // Bia's own message is "sent" on her side until Ana's answer.
    const answer = bia.dm.send(conv, 'oi!', null);
    expect(answer.delivered).toBe(false);
    await timers.advance(ACK_DELAY_MS);
    expect(bia.dm.history(conv, null, 50).map((m) => m.delivered)).toEqual([true, true]);
    // A delivered message is announced once.
    await timers.advance(10 * ACK_DELAY_MS);
    expect(ana.messageEvents().filter((m) => m.id === sent.id && m.delivered)).toHaveLength(1);
  });

  it('keeps messages for a friend offline and delivers them in order when they come back', async () => {
    const { ana, bia, timers, world } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.quit();
    const sent = ['um', 'dois', 'três'].map((text) => ana.dm.send(conv, text, null));
    expect(sent.map((m) => m.delivered)).toEqual([false, false, false]);
    await timers.advance(60_000);
    expect(ana.dm.history(conv, null, 50).map((m) => m.delivered)).toEqual([false, false, false]);

    bia.start();
    await world.settle();
    expect(bia.texts(ana)).toEqual(['um', 'dois', 'três']);
    expect(bia.messageEvents().map((m) => m.text)).toEqual(['um', 'dois', 'três']);
    await timers.advance(ACK_DELAY_MS);
    expect(ana.dm.history(conv, null, 50).map((m) => m.delivered)).toEqual([true, true, true]);
    expect(ana.messageEvents().filter((m) => m.delivered).map((m) => m.text)).toEqual(['um', 'dois', 'três']);
  });

  it('gets what the friend wrote while this app was closed', async () => {
    const { ana, bia, world } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    ana.dm.send(conv, 'oi', null);
    ana.quit();
    bia.dm.send(conv, 'você sumiu', null);
    bia.dm.send(conv, 'responde!', null);
    ana.start();
    await world.settle();
    expect(ana.texts(bia)).toEqual(['oi', 'você sumiu', 'responde!']);
    expect(ana.summary(bia)).toMatchObject({ unread: 2, lastText: 'responde!' });
  });

  it(`asks for at most ${WANT_MAX} entries at a time and gets them all, in order`, async () => {
    const { ana, bia, world, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.quit();
    const count = WANT_MAX * 2 + 1;
    for (let i = 1; i <= count; i++) {
      timers.now += 1;
      ana.dm.send(conv, `#${i}`, null);
    }
    bia.start();
    await world.settle();
    const texts = bia.texts(ana);
    expect(bia.dm.history(conv, null, 200)).toHaveLength(200);
    expect(texts.at(-1)).toBe(`#${count}`);
    expect(bia.store.dm.head(conv, ana.key)).toBe(count);
    const wants = bia.node.links.get(hexOf(ana.key))!.messages.filter((m) => m.t === 'sync.want');
    expect(wants.map((m) => m.t === 'sync.want' && [m.from, m.to])).toEqual([[1, WANT_MAX], [WANT_MAX + 1, 2 * WANT_MAX], [2 * WANT_MAX + 1, count]]);
    // 1001 signed entries written and verified: a Windows CI runner needed 42 s.
  }, 120_000);

  it('refuses empty, blank and oversized text, and cleans it like a channel message', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    expect(codeOf(() => ana.dm.send(conv, '', null))).toBe('BAD_REQUEST');
    expect(codeOf(() => ana.dm.send(conv, ' \n\t ', null))).toBe('BAD_REQUEST');
    expect(codeOf(() => ana.dm.send(conv, '\u0000\u0007', null))).toBe('BAD_REQUEST');
    expect(codeOf(() => ana.dm.send(conv, 'x'.repeat(DM_TEXT_MAX + 1), null))).toBe('BAD_REQUEST');
    expect(ana.dm.send(conv, 'x'.repeat(DM_TEXT_MAX), null).text).toHaveLength(DM_TEXT_MAX);
    // Spaces around do not count against the limit.
    expect(ana.dm.send(conv, `  ${'y'.repeat(DM_TEXT_MAX)}\n`, null).text).toHaveLength(DM_TEXT_MAX);
    expect(ana.dm.send(conv, '  oi\r\ntudo\u0000 bem?  ', null).text).toBe('oi\ntudo bem?');
    expect(bia.texts(ana).at(-1)).toBe('oi\ntudo bem?');
  });

  it('replies only to a message of that conversation', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    expect(codeOf(() => ana.dm.send(conv, 'oi', 'ab'.repeat(16)))).toBe('NOT_FOUND');
    const first = ana.dm.send(conv, 'pergunta', null);
    expect(ana.dm.send(conv, 'complemento', first.id).replyTo).toBe(first.id);
    expect(bia.dm.history(conv, null, 50).at(-1)!.replyTo).toBe(first.id);
  });

  it('lists conversations with the newest first, hidden ones included', async () => {
    const { ana, bia, person, timers, world } = await friendsAlready();
    const cleo = person('Cleo').start();
    ana.friends.add(cleo.friends.code());
    await flush();
    cleo.friends.accept(ana.key);
    await world.settle();
    const withBia = ana.dm.open(bia.key).id;
    await timers.advance(1_000);
    const withCleo = ana.dm.open(cleo.key).id;
    expect(ana.dm.conversations().map((c) => c.id)).toEqual([withCleo, withBia]);
    await timers.advance(1_000);
    bia.dm.open(ana.key);
    bia.dm.send(withBia, 'oi', null);
    ana.dm.hide(withBia);
    expect(ana.dm.conversations().map((c) => [c.id, c.hidden])).toEqual([[withBia, true], [withCleo, false]]);
  });
});

describe('editing and deleting (friends spec §4.2)', () => {
  it('edit and delete reach the friend, and every entry stays in the log', async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const sent = ana.dm.send(conv, 'oi', null);
    await timers.advance(5_000);
    const edited = ana.dm.edit(conv, sent.id, 'oi!');
    expect(edited).toMatchObject({ id: sent.id, text: 'oi!', editedAt: timers.now, deleted: false, ts: sent.ts });
    expect(bia.dm.history(conv, null, 50)).toEqual([{ ...edited, mine: false, delivered: true }]);
    expect(bia.messageEvents().at(-1)).toMatchObject({ id: sent.id, text: 'oi!' });

    const removed = ana.dm.remove(conv, sent.id);
    expect(removed).toMatchObject({ id: sent.id, text: '', deleted: true });
    expect(bia.dm.history(conv, null, 50)).toEqual([{ ...removed, mine: false, delivered: true }]);
    expect(bia.messageEvents().at(-1)).toMatchObject({ id: sent.id, text: '', deleted: true });
    expect(bia.summary(ana)).toMatchObject({ lastText: '', unread: 0 });
    expect(bia.store.dm.head(conv, ana.key)).toBe(3);
  });

  it("only the author edits or deletes: FORBIDDEN for the friend's message, NOT_FOUND for an unknown one", async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const sent = ana.dm.send(conv, 'oi', null);
    expect(codeOf(() => bia.dm.edit(conv, sent.id, 'tchau'))).toBe('FORBIDDEN');
    expect(codeOf(() => bia.dm.remove(conv, sent.id))).toBe('FORBIDDEN');
    expect(codeOf(() => ana.dm.edit(conv, 'ab'.repeat(16), 'x'))).toBe('NOT_FOUND');
    expect(codeOf(() => ana.dm.remove(conv, 'ab'.repeat(16)))).toBe('NOT_FOUND');
    expect(codeOf(() => ana.dm.edit(conv, sent.id, ' '))).toBe('BAD_REQUEST');
    expect(ana.texts(bia)).toEqual(['oi']);
    expect(bia.texts(ana)).toEqual(['oi']);

    ana.dm.remove(conv, sent.id);
    expect(codeOf(() => ana.dm.edit(conv, sent.id, 'volta'))).toBe('NOT_FOUND');
    // Deleting again, or editing to the same text, writes nothing.
    const head = ana.store.dm.head(conv, ana.key);
    expect(ana.dm.remove(conv, sent.id)).toMatchObject({ deleted: true });
    const other = ana.dm.send(conv, 'mesma coisa', null);
    expect(ana.dm.edit(conv, other.id, '  mesma coisa ')).toEqual(other);
    expect(ana.store.dm.head(conv, ana.key)).toBe(head + 1);
  });

  it("a friend's signed edit of someone else's message is kept in their log and changes nothing", async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const sent = ana.dm.send(conv, 'meu texto', null);
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 1, { kind: 'edit', id: sent.id, text: 'hackeado' }, timers.now) });
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 2, { kind: 'delete', id: sent.id }, timers.now) });
    expect(link.closed).toBe(false);
    expect(ana.texts(bia)).toEqual(['meu texto']);
    expect(ana.store.dm.head(conv, bia.key)).toBe(2);
  });
});

describe('the read mark and unread counts (friends spec §8)', () => {
  it("counts the friend's messages after the read mark, never one's own", async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.dm.open(ana.key);
    const m = [];
    for (const text of ['a', 'b', 'c']) {
      m.push(bia.dm.send(conv, text, null));
      await timers.advance(1_000);
    }
    ana.dm.send(conv, 'own', null);
    expect(ana.summary(bia)!.unread).toBe(3);
    ana.dm.read(conv, m[1]!.ts);
    expect(ana.summary(bia)!.unread).toBe(1);
    expect(ana.conversationEvents().at(-1)!.unread).toBe(1);
    const events = ana.events.length;
    ana.dm.read(conv, m[0]!.ts);
    expect(ana.events).toHaveLength(events);
    // Ana's clock runs 10 minutes ahead of Bia's: reading "up to now" still leaves Bia's next message unread.
    ana.dm.read(conv, timers.now + 600_000);
    expect(ana.summary(bia)!.unread).toBe(0);
    await timers.advance(1_000);
    bia.dm.send(conv, 'd', null);
    expect(ana.summary(bia)!.unread).toBe(1);
  });
});

describe('hidden conversations (friends spec §8)', () => {
  it('a new message shows a hidden conversation again; an edit does not', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = bia.dm.open(ana.key).id;
    ana.dm.open(bia.key);
    const first = bia.dm.send(conv, 'oi', null);
    ana.dm.hide(conv);
    bia.dm.edit(conv, first.id, 'oi!');
    expect(ana.summary(bia)!.hidden).toBe(true);
    bia.dm.send(conv, 'tá aí?', null);
    expect(ana.summary(bia)!.hidden).toBe(false);
    expect(ana.conversationEvents().at(-1)).toMatchObject({ hidden: false, unread: 2 });
    // Writing in it shows it too.
    ana.dm.hide(conv);
    ana.dm.send(conv, 'tô', null);
    expect(ana.summary(bia)!.hidden).toBe(false);
  });
});

describe('typing (friends spec §3.3)', () => {
  it('sends one signal every 3 s at most, and only while the friend is online', async () => {
    const { ana, bia, timers, world } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.dm.open(ana.key);
    const typing = () => bia.events.filter((e) => e.type === 'typing');
    ana.dm.typing(conv);
    expect(typing()).toEqual([{ type: 'typing', conv, author: keyToText(ana.key) }]);
    ana.dm.typing(conv);
    await timers.advance(TYPING_INTERVAL_MS - 1);
    ana.dm.typing(conv);
    expect(typing()).toHaveLength(1);
    await timers.advance(1);
    ana.dm.typing(conv);
    expect(typing()).toHaveLength(2);

    bia.quit();
    await timers.advance(TYPING_INTERVAL_MS);
    ana.dm.typing(conv); // nobody to tell, and no error
    bia.start();
    await world.settle();
    ana.dm.typing(conv); // the first signal after she came back goes out at once
    expect(typing()).toHaveLength(3);
  });

  it('ignores typing for a conversation it does not have, or does not share', async () => {
    const { ana, bia } = await friendsAlready();
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    say(link, { t: 'typing', conv: ana.conv(bia) });
    say(link, { t: 'typing', conv: dmConversationId(bia.key, randomBytes(32)) });
    expect(ana.events).toEqual([]);
    expect(link.closed).toBe(false);
  });
});

describe('removed and blocked friends (friends spec §5.3)', () => {
  it('removing a friend stops the sync; the history stays readable and writing is FORBIDDEN', async () => {
    const { ana, bia, world, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    const first = ana.dm.send(conv, 'oi', null);
    timers.now += 1;
    bia.dm.send(conv, 'oi!', null);
    bia.quit();
    timers.now += 1;
    ana.dm.send(conv, 'ainda aí?', null);
    ana.friends.remove(bia.key);

    expect(codeOf(() => ana.dm.send(conv, 'tchau', null))).toBe('FORBIDDEN');
    expect(codeOf(() => ana.dm.edit(conv, first.id, 'x'))).toBe('FORBIDDEN');
    expect(codeOf(() => ana.dm.remove(conv, first.id))).toBe('FORBIDDEN');
    expect(codeOf(() => ana.dm.open(bia.key))).toBe('FORBIDDEN');
    ana.dm.typing(conv);
    expect(ana.texts(bia)).toEqual(['oi', 'oi!', 'ainda aí?']);
    expect(ana.dm.conversations().map((c) => c.id)).toEqual([conv]);

    // Bia never heard of it and still writes; nothing crosses any more.
    bia.start();
    timers.now += 1;
    bia.dm.send(conv, 'oi?', null);
    await world.settle();
    expect(ana.texts(bia)).toEqual(['oi', 'oi!', 'ainda aí?']);
    expect(bia.texts(ana)).toEqual(['oi', 'oi!', 'oi?']);
  });

  it('a friend removed on an open link stops syncing at once, on both sides', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    ana.dm.send(conv, 'oi', null);
    ana.friends.remove(bia.key);
    expect(codeOf(() => bia.dm.send(conv, 'por quê?', null))).toBe('FORBIDDEN');
    expect(bia.texts(ana)).toEqual(['oi']);
  });

  it('blocking works the same way', async () => {
    const { ana, bia } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.dm.open(ana.key);
    bia.dm.send(conv, 'oi', null);
    ana.friends.block(bia.key);
    expect(codeOf(() => ana.dm.send(conv, 'x', null))).toBe('FORBIDDEN');
    expect(ana.texts(bia)).toEqual(['oi']);
    expect(ana.dm.history(conv, null, 50)).toHaveLength(1);
  });
});

describe('what a friend link refuses (friends spec §4.2, §11)', () => {
  it('drops the link on an entry with a bad signature, and keeps nothing of it', async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.conv(bia);
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    const good = entryOf(bia.signer, conv, 1, msg(1, 'oi'), timers.now);
    say(link, { t: 'entry', entry: { ...good, body: entryBodyJson(msg(1, 'tchau')) } });
    expect(link.closed).toBe(true);
    expect(ana.store.dm.conversation(conv)).toBeUndefined();
    expect(ana.events).toEqual([]);
  });

  it('drops a non-member, another conversation, a future ts and a gap without a word, and asks for the gap', async () => {
    const { ana, bia, timers, person } = await friendsAlready();
    const eva = person('Eva');
    const conv = ana.conv(bia);
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    say(link, { t: 'entry', entry: entryOf(eva.signer, conv, 1, msg(1), timers.now) });
    say(link, { t: 'entry', entry: entryOf(bia.signer, dmConversationId(bia.key, eva.key), 1, msg(2), timers.now) });
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 1, msg(3), timers.now + ENTRY_MAX_FUTURE_MS + 1) });
    expect(heard(link).filter((m) => m.t === 'sync.want')).toEqual([]);
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 3, msg(4), timers.now) });
    expect(link.closed).toBe(false);
    expect(ana.store.dm.conversation(conv)).toBeUndefined();
    expect(ana.events).toEqual([]);
    // The entry that came too early says how far Bia's log goes: Ana asks for it.
    expect(heard(link).filter((m) => m.t === 'sync.want')).toEqual([{ t: 'sync.want', conv, author: keyToText(bia.key), from: 1, to: 3 }]);
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 1, msg(5, 'um'), timers.now) });
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 2, msg(6, 'dois'), timers.now) });
    say(link, { t: 'entry', entry: entryOf(bia.signer, conv, 3, msg(7, 'três'), timers.now) });
    expect(ana.texts(bia)).toEqual(['um', 'dois', 'três']);
  });

  it('takes no entry from someone who is not a friend (a request still waiting)', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const cleo = person('Cleo');
    ana.friends.add(encodeFriendCode(cleo.key, randomBytes(16)));
    const link = rawLink(ana, cleo.key);
    say(link, { t: 'hello', v: 1, nickname: 'Cleo' });
    say(link, { t: 'entry', entry: entryOf(cleo.signer, ana.conv(cleo), 1, msg(1), timers.now) });
    say(link, { t: 'sync.have', convs: [{ id: ana.conv(cleo), heads: { [keyToText(cleo.key)]: 4 } }] });
    expect(link.closed).toBe(false);
    expect(ana.store.dm.conversations()).toEqual([]);
    expect(heard(link).filter((m) => m.t.startsWith('sync.'))).toEqual([]);
  });

  it(`answers sync.want only for the shared conversation and its members, with ${WANT_MAX} entries at most`, async () => {
    const { ana, bia, person } = await friendsAlready();
    const eva = person('Eva');
    const conv = ana.dm.open(bia.key).id;
    bia.quit();
    for (let i = 1; i <= WANT_MAX + 20; i++) ana.dm.send(conv, `#${i}`, null);
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    // Ana announced what she has.
    expect(heard(link)).toContainEqual({ t: 'sync.have', convs: [{ id: conv, heads: { [keyToText(ana.key)]: WANT_MAX + 20 } }] });
    const entries = () => heard(link).filter((m) => m.t === 'entry');
    say(link, { t: 'sync.want', conv: dmConversationId(ana.key, eva.key), author: keyToText(ana.key), from: 1, to: 10 });
    say(link, { t: 'sync.want', conv, author: keyToText(eva.key), from: 1, to: 10 });
    expect(entries()).toEqual([]);
    say(link, { t: 'sync.want', conv, author: keyToText(ana.key), from: 3, to: 100_000 });
    const seqs = entries().map((m) => m.t === 'entry' && m.entry.seq);
    expect(seqs).toHaveLength(WANT_MAX);
    expect(seqs[0]).toBe(3);
    expect(seqs.at(-1)).toBe(WANT_MAX + 2);
  });

  it('ignores a sync.have about conversations it does not share', async () => {
    const { ana, bia, person } = await friendsAlready();
    const eva = person('Eva');
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    say(link, { t: 'sync.have', convs: [{ id: dmConversationId(bia.key, eva.key), heads: { [keyToText(eva.key)]: 9, [keyToText(bia.key)]: 9 } }] });
    // Eva is no member of Ana and Bia's conversation: Ana asks only for Bia's entries.
    say(link, { t: 'sync.have', convs: [{ id: ana.conv(bia), heads: { [keyToText(eva.key)]: 9, [keyToText(bia.key)]: 2 } }] });
    expect(heard(link).filter((m) => m.t === 'sync.want')).toEqual([{ t: 'sync.want', conv: ana.conv(bia), author: keyToText(bia.key), from: 1, to: 2 }]);
  });
});

describe('notifications (friends spec §8)', () => {
  it("shows the friend's name and the newest text of a burst, never one's own messages", async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.dm.open(ana.key);
    bia.dm.send(conv, 'oi', null);
    expect(ana.notes).toEqual([]);
    await timers.advance(NOTIFY_DELAY_MS);
    expect(ana.notes).toEqual([{ conv, title: 'Bia', body: 'oi' }]);
    bia.dm.send(conv, 'tudo bem?', null);
    bia.dm.send(conv, 'responde', null);
    await timers.advance(NOTIFY_DELAY_MS);
    expect(ana.notes.slice(1)).toEqual([{ conv, title: 'Bia', body: 'responde' }]);
    ana.dm.send(conv, 'calma', null);
    await timers.advance(NOTIFY_DELAY_MS);
    expect(ana.notes).toHaveLength(2);
    expect(bia.notes).toEqual([{ conv, title: 'Ana', body: 'calma' }]);

    ana.friends.rename(bia.key, 'Bia do trabalho');
    bia.dm.send(conv, 'oi de novo', null);
    await timers.advance(NOTIFY_DELAY_MS);
    expect(ana.notes.at(-1)).toEqual({ conv, title: 'Bia do trabalho', body: 'oi de novo' });
  });

  it('shows nothing for a message deleted before the notification went out, nor for edits', async () => {
    const { ana, bia, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    bia.dm.open(ana.key);
    const sent = bia.dm.send(conv, 'ops', null);
    bia.dm.remove(conv, sent.id);
    await timers.advance(NOTIFY_DELAY_MS);
    const other = bia.dm.send(conv, 'oi', null);
    await timers.advance(NOTIFY_DELAY_MS);
    bia.dm.edit(conv, other.id, 'oi!');
    await timers.advance(NOTIFY_DELAY_MS);
    expect(ana.notes).toEqual([{ conv, title: 'Bia', body: 'oi' }]);
  });
});

describe('restarts and a new installation', () => {
  it('keeps everything across a restart and goes on with the next seq', async () => {
    const { ana, bia, timers, world } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    ana.dm.send(conv, 'um', null);
    ana.dm.read(conv, timers.now);
    ana.quit();
    ana.start();
    await world.settle();
    expect(ana.texts(bia)).toEqual(['um']);
    ana.dm.send(conv, 'dois', null);
    expect(bia.texts(ana)).toEqual(['um', 'dois']);
    expect(ana.store.dm.head(conv, ana.key)).toBe(2);
  });

  it("a reinstalled app gets its own messages back from the friend and goes on after them", async () => {
    const { ana, bia, person, world, timers } = await friendsAlready();
    const conv = ana.dm.open(bia.key).id;
    ana.dm.send(conv, 'um', null);
    ana.dm.send(conv, 'dois', null);
    timers.now += 1;
    bia.dm.send(conv, 'oi', null);
    timers.now += 1;
    ana.quit();
    // The same identity on a fresh database: Bia still has her as a friend and answers her request.
    const again = person('Ana').start();
    again.friends.add(bia.friends.code());
    await world.settle();
    expect(again.friends.list()[0]).toMatchObject({ state: 'friend', online: true });
    expect(again.dm.history(conv, null, 50).map((m) => [m.text, m.mine])).toEqual([['um', true], ['dois', true], ['oi', false]]);
    again.dm.send(conv, 'voltei', null);
    expect(bia.texts(again)).toEqual(['um', 'dois', 'oi', 'voltei']);
  });
});
