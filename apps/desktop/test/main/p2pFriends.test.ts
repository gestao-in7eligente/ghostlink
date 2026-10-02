import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import type { Friend } from '../../src/shared/friendsTypes.js';
import { encodeMessage, type P2pMessage } from '../../src/main/p2p/frames.js';
import { decodeFriendCode, encodeFriendCode, inboxPublicKey, inboxSeed, shortCode } from '../../src/main/p2p/friendCode.js';
import { friendKeyFromSeed, keyToText } from '../../src/main/p2p/friendKey.js';
import { FRIENDS_MAX, Friends, LINK_TIMEOUT_MS, PENDING_IN_MAX, PING_INTERVAL_MS, retryDelayMs } from '../../src/main/p2p/friends.js';
import { INBOX_MAX_OPEN, INBOX_MAX_PER_HOUR, serveInbox } from '../../src/main/p2p/inbox.js';
import { FriendsStore } from '../../src/main/p2p/store.js';
import { FakeWorld, ManualTimers, flush, hexOf, linkPair, type FakeLink, type FakeNode } from '../helpers/p2pFakes.js';

const dirs: string[] = [];
const stores: FriendsStore[] = [];
afterEach(() => {
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

/** A world with one clock; every person has a friend key, a database and the rules under test. */
function setup() {
  const world = new FakeWorld();
  const timers = new ManualTimers();
  const person = (name: string) => {
    const key = friendKeyFromSeed(createHash('sha256').update(name).digest());
    const dir = mkdtempSync(join(tmpdir(), 'ghostlink-friends-'));
    dirs.push(dir);
    const store = FriendsStore.open(dir, key.publicKey);
    stores.push(store);
    const state = { nickname: name, changes: 0 };
    const create = () => new Friends({ store, key, nickname: () => state.nickname, onChange: () => state.changes++, now: () => timers.now, timers });
    let friends = create();
    const node = world.node(key.publicKey, (remote) => friends.allows(remote));
    return {
      name,
      key: key.publicKey,
      signer: key,
      store,
      node,
      state,
      get friends() {
        return friends;
      },
      code: () => friends.code(),
      /** The app starts: the rules meet the network. */
      start() {
        node.online = true;
        friends.attach(node);
        return this;
      },
      /** The app closes: every link drops; a later start() is a fresh process over the same database. */
      quit() {
        friends.detach();
        node.goOffline();
        node.wanted.clear();
        node.inbox = null;
        friends = create();
      },
      /** How this person sees someone: "state" plus " online", or undefined when there is no row. */
      sees(other: { key: Uint8Array }): string | undefined {
        const row = friends.list().find((f) => f.key === keyToText(other.key));
        return row && `${row.state}${row.online ? ' online' : ''}`;
      },
      row(other: { key: Uint8Array }): Friend | undefined {
        return friends.list().find((f) => f.key === keyToText(other.key));
      },
    };
  };
  return { world, timers, person };
}

/** Two people who already are friends and online. */
async function friendsAlready() {
  const s = setup();
  const ana = s.person('Ana').start();
  const bia = s.person('Bia').start();
  ana.friends.add(bia.code());
  await flush();
  bia.friends.accept(ana.key);
  await s.world.settle();
  expect(ana.sees(bia)).toBe('friend online');
  expect(bia.sees(ana)).toBe('friend online');
  return { ...s, ana, bia };
}

/** A friend link opened by hand into `person`, for messages the honest code would never send. */
function rawLink(person: { node: FakeNode; key: Uint8Array }, remoteKey: Uint8Array): FakeLink {
  const [theirs, mine] = linkPair(person.key, remoteKey);
  for (const listener of person.node.listeners) listener(theirs);
  return mine;
}
const say = (link: FakeLink, message: P2pMessage) => link.send(encodeMessage(message));

describe('adding by code (friends spec §5.1)', () => {
  it('refuses what is not a code and the person\'s own code', () => {
    const { person } = setup();
    const ana = person('Ana').start();
    expect(codeOf(() => ana.friends.add('GLF1-NOPE'))).toBe('FRIEND_CODE_INVALID');
    expect(codeOf(() => ana.friends.add(`${ana.code().slice(0, -1)}B`))).toBe('FRIEND_CODE_INVALID');
    expect(codeOf(() => ana.friends.add(ana.code()))).toBe('FRIEND_SELF');
    // The own key with any other invite secret is still the own code.
    expect(codeOf(() => ana.friends.add(encodeFriendCode(ana.key, randomBytes(16))))).toBe('FRIEND_SELF');
    expect(ana.friends.list()).toEqual([]);
    expect(ana.state.changes).toBe(0);
  });

  it('creates the pending_out row at once, lets that key through the firewall and knocks on its inbox', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia'); // not running
    expect(ana.friends.allows(bia.key)).toBe(false);

    ana.friends.add(bia.code());
    expect(ana.friends.list()).toEqual([
      { key: keyToText(bia.key), shortCode: shortCode(bia.key), nickname: '', localName: null, state: 'pending_out', online: false, since: timers.now },
    ]);
    expect(ana.state.changes).toBe(1);
    expect(ana.friends.allows(bia.key)).toBe(true);
    expect([...ana.node.wanted]).toEqual([hexOf(bia.key)]);
    const { friendPub, inviteSecret } = decodeFriendCode(bia.code());
    expect(ana.node.knocked).toEqual([hexOf(inboxPublicKey(friendPub, inviteSecret))]);
  });

  it('stops at 500 friends and requests sent; requests received and blocked people do not count', () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    const fill = (from: number, count: number, state: 'friend' | 'pending_out' | 'pending_in' | 'blocked') => {
      for (let i = from; i < from + count; i++) {
        const key = createHash('sha256').update(`filler-${i}`).digest();
        ana.store.put({ key, nickname: '', localName: null, state, since: i, inviteSecret: null });
      }
    };
    fill(0, 50, 'pending_in');
    fill(100, 50, 'blocked');
    fill(200, FRIENDS_MAX - 101, 'friend');
    fill(1_000, 100, 'pending_out');
    ana.friends.add(bia.code());
    expect(ana.sees(bia)).toBe('pending_out');
    const cleo = person('Cleo');
    expect(codeOf(() => ana.friends.add(cleo.code()))).toBe('FRIEND_LIMIT');
    expect(ana.sees(cleo)).toBeUndefined();
    // Asking again for someone already asked is not one more.
    expect(codeOf(() => ana.friends.add(bia.code()))).toBeUndefined();
  }, 120_000); // 500 friends on a slow Windows CI runner took over 20 s

  it('knocks on the new inbox when a pending person is added again with a new code', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    ana.friends.add(bia.code());
    const newer = encodeFriendCode(bia.key, randomBytes(16));
    ana.friends.add(newer);
    const { friendPub, inviteSecret } = decodeFriendCode(newer);
    expect(ana.node.knocked.at(-1)).toBe(hexOf(inboxPublicKey(friendPub, inviteSecret)));
    expect(ana.friends.list()).toHaveLength(1);
  });

  it('does nothing for someone who already is a friend', async () => {
    const { ana, bia } = await friendsAlready();
    const knocks = ana.node.knocked.length;
    ana.friends.add(bia.code());
    await flush();
    expect(ana.sees(bia)).toBe('friend online');
    expect(ana.node.knocked).toHaveLength(knocks);
  });
});

describe('a request from the code to the friendship (friends spec §5.1)', () => {
  it('request by code → pending_in → accept → both are friends and online', async () => {
    const { world, person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();

    ana.friends.add(bia.code());
    await flush();
    expect(ana.sees(bia)).toBe('pending_out');
    expect(bia.row(ana)).toEqual({
      key: keyToText(ana.key), shortCode: shortCode(ana.key), nickname: 'Ana', localName: null, state: 'pending_in', online: false, since: timers.now,
    });
    // The request arrived: the invite secret is not kept any longer, and no retry waits.
    expect(ana.store.get(bia.key)!.inviteSecret).toBeNull();
    expect(world.inboxLinks.every((l) => l.asker.closed && l.owner.closed)).toBe(true);
    // Until Bia accepts, Ana's key does not pass Bia's firewall.
    expect(bia.friends.allows(ana.key)).toBe(false);
    await world.settle();
    expect(bia.node.links.size).toBe(0);

    await timers.advance(1_000);
    bia.friends.accept(ana.key);
    await world.settle();
    expect(bia.row(ana)).toMatchObject({ state: 'friend', online: true, nickname: 'Ana', since: timers.now });
    expect(ana.row(bia)).toMatchObject({ state: 'friend', online: true, nickname: 'Bia', since: timers.now });
  });

  it('tells the renderer about every step', async () => {
    const { world, person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    ana.friends.add(bia.code());
    await flush();
    expect(bia.state.changes).toBe(1); // the request arrived
    const before = ana.state.changes;
    bia.friends.accept(ana.key);
    await world.settle();
    expect(ana.state.changes).toBeGreaterThan(before); // accepted, online
    expect(bia.state.changes).toBeGreaterThan(2);
  });

  it('keeps knocking while the person is offline, with pauses that grow up to 10 minutes', async () => {
    const { world, person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia'); // offline
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000]);

    ana.friends.add(bia.code());
    await flush();
    expect(ana.node.knocked).toHaveLength(1);
    await timers.advance(4_999);
    expect(ana.node.knocked).toHaveLength(1);
    await timers.advance(1);
    expect(ana.node.knocked).toHaveLength(2);
    await timers.advance(10_000);
    expect(ana.node.knocked).toHaveLength(3);
    await timers.advance(20_000 + 40_000 + 80_000 + 160_000 + 320_000);
    expect(ana.node.knocked).toHaveLength(8);
    await timers.advance(600_000);
    expect(ana.node.knocked).toHaveLength(9);
    expect(ana.store.get(bia.key)!.inviteSecret).not.toBeNull();

    bia.start();
    await timers.advance(600_000);
    expect(bia.sees(ana)).toBe('pending_in');
    expect(ana.store.get(bia.key)!.inviteSecret).toBeNull();
    // Delivered: nothing more goes out.
    const knocks = ana.node.knocked.length;
    await timers.advance(3_600_000);
    expect(ana.node.knocked).toHaveLength(knocks);
    expect(world.inboxLinks).toHaveLength(1);
  });

  it('resumes an undelivered request after a restart, and never repeats a delivered one', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    const cleo = person('Cleo').start();
    ana.friends.add(bia.code());
    ana.friends.add(cleo.code());
    await flush();
    expect(cleo.sees(ana)).toBe('pending_in');
    cleo.friends.dismiss(ana.key);

    ana.quit();
    bia.start();
    ana.start();
    await flush();
    expect(bia.sees(ana)).toBe('pending_in');
    // Cleo declined; Ana's app does not ask her again by itself.
    expect(cleo.sees(ana)).toBeUndefined();
    expect(ana.sees(cleo)).toBe('pending_out');
  });

  it('befriends at once when the person accepted while we were away', async () => {
    const { world, person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    ana.friends.add(bia.code());
    await flush();
    ana.quit();
    bia.friends.accept(ana.key);
    await world.settle();
    expect(bia.sees(ana)).toBe('friend');

    // Ana reaches for everyone she asked, so the answer does not wait for Bia's next retry.
    ana.start();
    await flush();
    expect(ana.sees(bia)).toBe('friend online');
    expect(bia.sees(ana)).toBe('friend online');
  });

  it('crossed requests become a friendship without anyone accepting', async () => {
    const { world, person } = setup();
    const ana = person('Ana');
    const bia = person('Bia');
    // Both ask while the other is away, then both come online.
    ana.start();
    ana.friends.add(bia.code());
    ana.quit();
    bia.start();
    bia.friends.add(ana.code());
    await flush();
    ana.start();
    await world.settle();
    expect(ana.sees(bia)).toBe('friend online');
    expect(bia.sees(ana)).toBe('friend online');
    expect(ana.row(bia)!.nickname).toBe('Bia');
    expect(bia.row(ana)!.nickname).toBe('Ana');
  });

  it('adding the code of someone who already asked accepts their request', async () => {
    const { world, person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    ana.friends.add(bia.code());
    await flush();
    expect(bia.sees(ana)).toBe('pending_in');
    const knocks = bia.node.knocked.length;
    bia.friends.add(ana.code());
    await world.settle();
    expect(bia.node.knocked).toHaveLength(knocks); // no request goes back
    expect(ana.sees(bia)).toBe('friend online');
    expect(bia.sees(ana)).toBe('friend online');
  });

  it('never hands the request to a fake inbox: the right inbox key, another friend key', async () => {
    const { world, person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia'); // offline
    // Mallory saw Bia's code, so she can listen on Bia's inbox key. She cannot sign as Bia.
    const mallory = person('Mallory');
    const { friendPub, inviteSecret } = decodeFriendCode(bia.code());
    const stolen: string[] = [];
    await mallory.node.setInbox({
      seed: inboxSeed(friendPub, inviteSecret),
      allow: () => true,
      onLink: (link) => serveInbox(link, { key: mallory.signer, inviteSecret, timers, onRequest: (_from, nickname) => stolen.push(nickname) }),
    });

    ana.friends.add(bia.code());
    await flush();
    expect(world.inboxLinks).toHaveLength(1);
    expect(world.inboxLinks[0]!.asker.sent).toEqual([]);
    expect(world.inboxLinks[0]!.asker.closed).toBe(true);
    expect(stolen).toEqual([]);
    // Still undelivered: Ana will try again later.
    expect(ana.store.get(bia.key)!.inviteSecret).not.toBeNull();
    await timers.advance(5_000);
    expect(world.inboxLinks).toHaveLength(2);
    expect(stolen).toEqual([]);
  });
});

describe('the inbox owner\'s rules (friends spec §3.2, §3.4)', () => {
  it('drops requests of a blocked key without a sign', async () => {
    const { world, person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    ana.friends.add(bia.code());
    await flush();
    bia.friends.block(ana.key);
    expect(bia.sees(ana)).toBe('blocked');

    ana.friends.dismiss(bia.key);
    ana.friends.add(bia.code());
    await flush();
    // The inbox firewall refused the key: no connection, nothing changed, and Ana just sees "pending".
    expect(world.inboxLinks).toHaveLength(1);
    expect(bia.sees(ana)).toBe('blocked');
    expect(ana.sees(bia)).toBe('pending_out');
    expect(ana.store.get(bia.key)!.inviteSecret).not.toBeNull();
  });

  it('lets 30 strangers knock per hour, then refuses until the hour passed', async () => {
    const { world, person, timers } = setup();
    const bia = person('Bia').start();
    const strangers = Array.from({ length: INBOX_MAX_PER_HOUR + 2 }, (_, i) => person(`stranger-${i}`).start());
    // One after the other: a burst would first meet the limit of 8 at once.
    for (const s of strangers.slice(0, INBOX_MAX_PER_HOUR + 1)) {
      s.friends.add(bia.code());
      await flush();
    }
    expect(world.inboxLinks).toHaveLength(INBOX_MAX_PER_HOUR);
    expect(bia.friends.list()).toHaveLength(INBOX_MAX_PER_HOUR);
    expect(bia.sees(strangers[INBOX_MAX_PER_HOUR]!)).toBeUndefined();

    // The refused one retries by itself and gets in once the window moved.
    await timers.advance(3_700_000);
    expect(bia.sees(strangers[INBOX_MAX_PER_HOUR]!)).toBe('pending_in');
    strangers[INBOX_MAX_PER_HOUR + 1]!.friends.add(bia.code());
    await flush();
    expect(bia.sees(strangers[INBOX_MAX_PER_HOUR + 1]!)).toBe('pending_in');
  });

  it('holds at most 8 inbox connections from strangers at once', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    const open: FakeLink[] = [];
    // Strangers that connect and then say nothing.
    for (let i = 0; i < INBOX_MAX_OPEN; i++) {
      const key = randomBytes(32);
      expect(bia.node.inbox!.allow(key)).toBe(true);
      const [ownerEnd, askerEnd] = linkPair(bia.key, key);
      bia.node.inbox!.onLink(ownerEnd);
      open.push(askerEnd);
    }
    expect(bia.node.inbox!.allow(randomBytes(32))).toBe(false);
    open[0]!.close();
    expect(bia.node.inbox!.allow(randomBytes(32))).toBe(true);
  });

  it('does not count people it already asked or befriended against the limits', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    for (let i = 0; i < INBOX_MAX_PER_HOUR; i++) expect(bia.node.inbox!.allow(randomBytes(32))).toBe(true);
    const stranger = person('Stranger');
    const asked = person('Asked');
    expect(bia.node.inbox!.allow(stranger.key)).toBe(false);
    bia.friends.add(asked.code());
    expect(bia.node.inbox!.allow(asked.key)).toBe(true);
  });

  it('keeps 100 requests at most: the oldest leaves', async () => {
    const { person, timers } = setup();
    const bia = person('Bia').start();
    for (let i = 0; i < PENDING_IN_MAX; i++) {
      bia.store.put({ key: createHash('sha256').update(`old-${i}`).digest(), nickname: `old-${i}`, localName: null, state: 'pending_in', since: timers.now - 1_000 + i, inviteSecret: null });
    }
    const ana = person('Ana').start();
    ana.friends.add(bia.code());
    await flush();
    const pending = bia.friends.list().filter((f) => f.state === 'pending_in');
    expect(pending).toHaveLength(PENDING_IN_MAX);
    expect(pending.some((f) => f.nickname === 'old-0')).toBe(false);
    expect(pending.some((f) => f.nickname === 'old-1')).toBe(true);
    expect(bia.sees(ana)).toBe('pending_in');
  });

  it('cleans the nickname a request carries', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    ana.state.nickname = `  A\u202Ena\u0000 ${'x'.repeat(60)}`;
    ana.friends.add(bia.code());
    await flush();
    const nickname = bia.row(ana)!.nickname;
    expect(nickname.startsWith('Ana x')).toBe(true);
    expect([...nickname]).toHaveLength(32);
  });

  it('sends the longest nickname the settings allow, whole, within the frame limits', async () => {
    const { world, person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    // 32 graphemes of 10 code points each pass normalizeNickname; that is 320 characters.
    ana.state.nickname = `\u0E01${'\u0E49'.repeat(9)}`.repeat(32);
    ana.friends.add(bia.code());
    await flush();
    expect(bia.sees(ana)).toBe('pending_in');
    const seen = bia.row(ana)!.nickname;
    expect(seen.length).toBeGreaterThan(200);
    expect(ana.state.nickname.startsWith(seen)).toBe(true);
    bia.friends.accept(ana.key);
    await world.settle();
    expect(bia.sees(ana)).toBe('friend online');
  });

  it('never cuts a nickname in the middle of a character', async () => {
    const { world, person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    ana.state.nickname = `a${'\u{1F600}'.repeat(200)}`;
    ana.friends.add(bia.code());
    await flush();
    bia.friends.accept(ana.key);
    await world.settle();
    const hello = ana.node.links.get(hexOf(bia.key))!.messages[0]!;
    // 'a' and 127 whole emoji: never half of a surrogate pair.
    expect(hello.t === 'hello' && !/\p{Cs}/u.test(hello.nickname) && hello.nickname.length).toBe(255);
  });

  it('a repeated request only refreshes the nickname', async () => {
    const { person, timers } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    ana.friends.add(bia.code());
    await flush();
    const since = bia.row(ana)!.since;
    await timers.advance(60_000);
    ana.friends.dismiss(bia.key);
    ana.state.nickname = 'Ana Maria';
    ana.friends.add(bia.code());
    await flush();
    expect(bia.friends.list()).toHaveLength(1);
    expect(bia.row(ana)).toMatchObject({ state: 'pending_in', nickname: 'Ana Maria', since });
  });

  it('a request from someone who already is a friend brings them back without asking again', async () => {
    const { world, ana, bia } = await friendsAlready();
    // Ana lost Bia (say, a removal that never reached Bia), and asks again.
    ana.store.remove(bia.key);
    for (const link of [...ana.node.links.values()]) link.close();
    ana.node.wanted.clear();
    ana.friends.add(bia.code());
    await world.settle();
    expect(bia.sees(ana)).toBe('friend online');
    expect(ana.sees(bia)).toBe('friend online');
  });

  it('stops listening when requests by code are turned off, and listens again when turned on', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    expect(bia.node.inbox).not.toBeNull();
    bia.friends.setInbox(false);
    expect(bia.node.inbox).toBeNull();
    expect(bia.store.me.inboxEnabled).toBe(false);
    ana.friends.add(bia.code());
    await flush();
    expect(bia.sees(ana)).toBeUndefined();

    bia.quit();
    bia.start();
    expect(bia.node.inbox).toBeNull(); // the switch survives a restart
    bia.friends.setInbox(true);
    expect(bia.node.inbox).not.toBeNull();
  });

  it('a new code moves the inbox: the old code reaches nobody, friends stay', async () => {
    const { ana, bia, person, timers } = await friendsAlready();
    const oldCode = bia.code();
    const oldInbox = bia.node.inboxKey;
    bia.friends.newCode();
    expect(bia.code()).not.toBe(oldCode);
    expect(decodeFriendCode(bia.code()).friendPub).toEqual(decodeFriendCode(oldCode).friendPub);
    expect(bia.node.inboxKey).not.toBe(oldInbox);
    expect(bia.sees(ana)).toBe('friend online');

    const cleo = person('Cleo').start();
    cleo.friends.add(oldCode);
    await timers.advance(60_000);
    expect(bia.sees(cleo)).toBeUndefined();
    const dora = person('Dora').start();
    dora.friends.add(bia.code());
    await flush();
    expect(bia.sees(dora)).toBe('pending_in');
  });
});

describe('friend links (friends spec §3.2, §3.3)', () => {
  it('lets in only friends and people we asked', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const put = (name: string, state: 'friend' | 'pending_out' | 'pending_in' | 'blocked') => {
      const other = person(name);
      ana.store.put({ key: other.key, nickname: name, localName: null, state, since: 1, inviteSecret: null });
      return other;
    };
    expect(ana.friends.allows(put('f', 'friend').key)).toBe(true);
    expect(ana.friends.allows(put('o', 'pending_out').key)).toBe(true);
    expect(ana.friends.allows(put('i', 'pending_in').key)).toBe(false);
    expect(ana.friends.allows(put('b', 'blocked').key)).toBe(false);
    expect(ana.friends.allows(randomBytes(32))).toBe(false);
  });

  it('closes a link whose key is not allowed any more', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const link = rawLink(ana, randomBytes(32));
    expect(link.closed).toBe(true);
    expect(link.peer.sent).toEqual([]);
  });

  it('greets with hello and its nickname; a friend also confirms the friendship', async () => {
    const { ana, bia } = await friendsAlready();
    const sent = ana.node.links.get(hexOf(bia.key))!.messages;
    expect(sent[0]).toEqual({ t: 'hello', v: 1, nickname: 'Ana' });
    expect(sent).toContainEqual({ t: 'friend.accept' });
  });

  it('shows a friend online only after their hello, and offline when the link closes', async () => {
    const { ana, bia } = await friendsAlready();
    for (const link of [...ana.node.links.values()]) link.close();
    expect(ana.sees(bia)).toBe('friend');
    const changes = ana.state.changes;

    const link = rawLink(ana, bia.key);
    expect(ana.sees(bia)).toBe('friend');
    say(link, { t: 'hello', v: 1, nickname: 'Bia 2' });
    expect(ana.row(bia)).toMatchObject({ state: 'friend', online: true, nickname: 'Bia 2' });
    expect(ana.state.changes).toBe(changes + 1);
    link.close();
    expect(ana.sees(bia)).toBe('friend');
    expect(ana.state.changes).toBe(changes + 2);
  });

  it.each<[string, (link: FakeLink) => void]>([
    ['a message before hello', (link) => say(link, { t: 'ping' })],
    ['bytes that are not a frame', (link) => link.send(Buffer.from('oi'))],
    ['an inbox proof', (link) => {
      say(link, { t: 'hello', v: 1, nickname: 'Bia' });
      say(link, { t: 'inbox.hello', sig: 'A'.repeat(86) });
    }],
    ['a friend.request', (link) => {
      say(link, { t: 'hello', v: 1, nickname: 'Bia' });
      say(link, { t: 'friend.request', nickname: 'Bia', proof: `${'B'.repeat(42)}A` });
    }],
  ])('drops the link on %s', async (_label, act) => {
    const { ana, bia } = await friendsAlready();
    for (const link of [...ana.node.links.values()]) link.close();
    const link = rawLink(ana, bia.key);
    act(link);
    expect(link.closed).toBe(true);
    expect(ana.sees(bia)).toBe('friend');
  });

  it('answers ping with pong', async () => {
    const { ana, bia } = await friendsAlready();
    for (const link of [...ana.node.links.values()]) link.close();
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    say(link, { t: 'ping' });
    expect(link.peer.messages.at(-1)).toEqual({ t: 'pong' });
  });

  it('pings every 20 s and drops a link that stayed silent', async () => {
    const { ana, bia, timers } = await friendsAlready();
    for (const link of [...ana.node.links.values()]) link.close();
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    const pings = () => link.peer.messages.filter((m) => m.t === 'ping').length;
    await timers.advance(PING_INTERVAL_MS);
    expect(pings()).toBe(1);
    await timers.advance(PING_INTERVAL_MS);
    expect(pings()).toBe(2);
    expect(link.closed).toBe(false);
    expect(LINK_TIMEOUT_MS).toBeGreaterThan(2 * PING_INTERVAL_MS);
    await timers.advance(PING_INTERVAL_MS);
    expect(link.closed).toBe(true);
    expect(ana.sees(bia)).toBe('friend');
  });

  it('keeps a link whose other side answers', async () => {
    const { ana, bia, timers } = await friendsAlready();
    await timers.advance(10 * PING_INTERVAL_MS);
    expect(ana.sees(bia)).toBe('friend online');
    expect(bia.sees(ana)).toBe('friend online');
  });

  it('friend.accept from someone we asked makes the friendship; from anyone else it changes nothing', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    ana.friends.add(bia.code());
    await timers.advance(1_000);
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    expect(ana.sees(bia)).toBe('pending_out');
    say(link, { t: 'friend.accept' });
    expect(ana.row(bia)).toMatchObject({ state: 'friend', online: true, since: timers.now });
    expect(ana.store.get(bia.key)!.inviteSecret).toBeNull();
    say(link, { t: 'friend.accept' });
    expect(ana.sees(bia)).toBe('friend online');
    // No request keeps going out.
    const knocks = ana.node.knocked.length;
    await timers.advance(3_600_000);
    expect(ana.node.knocked).toHaveLength(knocks);
  });

  it('announces a changed nickname on the open links', async () => {
    const { ana, bia } = await friendsAlready();
    ana.state.nickname = 'Ana Clara';
    ana.friends.announceNickname();
    expect(bia.row(ana)!.nickname).toBe('Ana Clara');
    expect(bia.sees(ana)).toBe('friend online');
  });

  it('keeps the last nickname seen when a hello carries none', async () => {
    const { ana, bia } = await friendsAlready();
    ana.state.nickname = '';
    ana.friends.announceNickname();
    expect(bia.row(ana)!.nickname).toBe('Ana');
  });
});

describe('accept, decline, cancel, remove, block, rename (friends spec §5.1, §5.3)', () => {
  it('accept only works on a request that is waiting', async () => {
    const { ana, bia, person } = await friendsAlready();
    const cleo = person('Cleo');
    const changes = ana.state.changes;
    ana.friends.accept(bia.key);
    ana.friends.accept(cleo.key);
    expect(ana.sees(cleo)).toBeUndefined();
    expect(ana.state.changes).toBe(changes);
  });

  it('accept stops at 500 friends', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    ana.friends.add(bia.code());
    await flush();
    for (let i = 0; i < FRIENDS_MAX; i++) {
      bia.store.put({ key: createHash('sha256').update(`f-${i}`).digest(), nickname: '', localName: null, state: 'friend', since: i, inviteSecret: null });
    }
    expect(codeOf(() => bia.friends.accept(ana.key))).toBe('FRIEND_LIMIT');
    expect(bia.sees(ana)).toBe('pending_in');
  }, 120_000); // 500 friends on a slow Windows CI runner took over 20 s

  it('dismiss declines a request; the person may ask again', async () => {
    const { person } = setup();
    const bia = person('Bia').start();
    const ana = person('Ana').start();
    ana.friends.add(bia.code());
    await flush();
    bia.friends.dismiss(ana.key);
    expect(bia.sees(ana)).toBeUndefined();
    expect(ana.sees(bia)).toBe('pending_out'); // declining is silent

    ana.friends.dismiss(bia.key);
    ana.friends.add(bia.code());
    await flush();
    expect(bia.sees(ana)).toBe('pending_in');
  });

  it('dismiss cancels a request we sent: no more knocking, the key leaves the firewall', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    ana.friends.add(bia.code());
    await flush();
    ana.friends.dismiss(bia.key);
    expect(ana.sees(bia)).toBeUndefined();
    expect(ana.friends.allows(bia.key)).toBe(false);
    expect(ana.node.wanted.size).toBe(0);
    const knocks = ana.node.knocked.length;
    await timers.advance(3_600_000);
    expect(ana.node.knocked).toHaveLength(knocks);
  });

  it('dismiss does not end a friendship', async () => {
    const { ana, bia } = await friendsAlready();
    ana.friends.dismiss(bia.key);
    expect(ana.sees(bia)).toBe('friend online');
  });

  it('remove tells the other side, and both lose the friend', async () => {
    const { world, ana, bia } = await friendsAlready();
    const link = ana.node.links.get(hexOf(bia.key))!;
    ana.friends.remove(bia.key);
    expect(link.messages.at(-1)).toEqual({ t: 'friend.remove' });
    expect(ana.sees(bia)).toBeUndefined();
    expect(bia.sees(ana)).toBeUndefined();
    expect(link.closed).toBe(true);
    expect(ana.friends.allows(bia.key)).toBe(false);
    expect(bia.friends.allows(ana.key)).toBe(false);
    await world.settle();
    expect(ana.node.links.size + bia.node.links.size).toBe(0);
    expect(ana.node.wanted.size + bia.node.wanted.size).toBe(0);
  });

  it('remove while the friend is offline only forgets them here; they just see us offline', async () => {
    const { world, ana, bia } = await friendsAlready();
    bia.quit();
    ana.friends.remove(bia.key);
    expect(ana.sees(bia)).toBeUndefined();
    bia.start();
    await world.settle();
    expect(bia.sees(ana)).toBe('friend');
    expect(ana.node.links.size).toBe(0);
  });

  it('remove only applies to a friend', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia');
    ana.friends.add(bia.code());
    ana.friends.remove(bia.key);
    expect(ana.sees(bia)).toBe('pending_out');
  });

  it('closes a link by itself when the removed friend never hangs up', async () => {
    const { ana, bia, timers } = await friendsAlready();
    for (const link of [...ana.node.links.values()]) link.close();
    const link = rawLink(ana, bia.key);
    say(link, { t: 'hello', v: 1, nickname: 'Bia' });
    ana.friends.remove(bia.key);
    expect(link.peer.ended).toBe(true);
    expect(link.closed).toBe(false);
    await timers.advance(5_000);
    expect(link.closed).toBe(true);
  });

  it('block ends the friendship, keeps the key as blocked and refuses it everywhere', async () => {
    const { world, ana, bia, timers } = await friendsAlready();
    await timers.advance(1_000);
    ana.friends.block(bia.key);
    expect(ana.row(bia)).toMatchObject({ state: 'blocked', online: false, nickname: 'Bia', since: timers.now });
    expect(bia.sees(ana)).toBeUndefined(); // Bia got friend.remove
    expect(ana.friends.allows(bia.key)).toBe(false);

    bia.friends.add(ana.code());
    await world.settle();
    expect(ana.sees(bia)).toBe('blocked');
    expect(bia.sees(ana)).toBe('pending_out');
    expect(ana.node.links.size).toBe(0);
  });

  it('block works on a request received and on one sent', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    const cleo = person('Cleo');
    bia.friends.add(ana.code());
    ana.friends.add(cleo.code());
    await flush();
    ana.friends.block(bia.key);
    ana.friends.block(cleo.key);
    expect(ana.sees(bia)).toBe('blocked');
    expect(ana.sees(cleo)).toBe('blocked');
    expect(ana.friends.allows(cleo.key)).toBe(false);
    const knocks = ana.node.knocked.length;
    await timers.advance(3_600_000);
    expect(ana.node.knocked).toHaveLength(knocks);
    // Someone never seen cannot be blocked: there is nothing to block.
    ana.friends.block(randomBytes(32));
    expect(ana.friends.list()).toHaveLength(2);
  });

  it('dismiss unblocks, and the person can ask again', async () => {
    const { person, timers } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    bia.friends.add(ana.code());
    await flush();
    ana.friends.block(bia.key);
    ana.friends.dismiss(bia.key);
    expect(ana.sees(bia)).toBeUndefined();
    bia.friends.dismiss(ana.key);
    bia.friends.add(ana.code());
    await timers.advance(1);
    expect(ana.sees(bia)).toBe('pending_in');
  });

  it('adding the code of someone blocked unblocks them and sends the request', async () => {
    const { person } = setup();
    const ana = person('Ana').start();
    const bia = person('Bia').start();
    bia.friends.add(ana.code());
    await flush();
    ana.friends.block(bia.key);
    ana.friends.add(bia.code());
    await flush();
    // Bia had asked too, so this is a crossed request.
    expect(ana.sees(bia)).toMatch(/^(pending_out|friend)/);
    expect(bia.sees(ana)).toMatch(/^friend/);
  });

  it('rename sets and clears the local nickname of any row', async () => {
    const { ana, bia } = await friendsAlready();
    ana.friends.rename(bia.key, 'Bia do trabalho');
    expect(ana.row(bia)).toMatchObject({ localName: 'Bia do trabalho', nickname: 'Bia', state: 'friend', online: true });
    ana.friends.rename(bia.key, null);
    expect(ana.row(bia)!.localName).toBeNull();
    const changes = ana.state.changes;
    ana.friends.rename(randomBytes(32), 'ninguém');
    expect(ana.friends.list()).toHaveLength(1);
    expect(ana.state.changes).toBe(changes);
  });
});

describe('the code and the engine going away', () => {
  it('code() is the friend key with the stored invite secret', () => {
    const { person } = setup();
    const ana = person('Ana');
    expect(ana.code()).toBe(encodeFriendCode(ana.key, ana.store.me.inviteSecret));
  });

  it('works on the database without a network: rows change, nothing is sent', () => {
    const { person } = setup();
    const ana = person('Ana'); // never started
    const bia = person('Bia');
    ana.friends.add(bia.code());
    expect(ana.sees(bia)).toBe('pending_out');
    expect(ana.node.knocked).toEqual([]);
    ana.friends.rename(bia.key, 'B');
    ana.friends.block(bia.key);
    ana.friends.dismiss(bia.key);
    ana.friends.newCode();
    ana.friends.setInbox(false);
    expect(ana.friends.list()).toEqual([]);
  });

  it('detach drops every link and timer; everyone shows offline', async () => {
    const { ana, bia, person, timers } = await friendsAlready();
    ana.friends.add(person('Cleo').code());
    await flush();
    expect(timers.pending).toBeGreaterThan(0);
    const before = timers.pending;
    ana.friends.detach();
    expect(ana.sees(bia)).toBe('friend');
    expect(bia.sees(ana)).toBe('friend');
    expect(ana.node.links.size).toBe(0);
    // Only Bia's own timer (her heartbeat) is left.
    expect(timers.pending).toBeLessThan(before);
    bia.friends.detach();
    expect(timers.pending).toBe(0);
  });
});
