import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '@ghostlink/shared';
import { encodeMessage, type P2pMessage } from '../../src/main/p2p/frames.js';
import { friendKeyFromSeed, signInboxProof, verifyInboxProof } from '../../src/main/p2p/friendKey.js';
import { INBOX_MAX_OPEN, INBOX_MAX_PER_HOUR, INBOX_TIMEOUT_MS, InboxLimiter, knock, serveInbox } from '../../src/main/p2p/inbox.js';
import { FakeLink, ManualTimers, flush, hexOf, linkPair } from '../helpers/p2pFakes.js';

const owner = friendKeyFromSeed(randomBytes(32));
const asker = friendKeyFromSeed(randomBytes(32));
const inboxKey = friendKeyFromSeed(randomBytes(32)).publicKey;

/** An inbox connection: the asker's end and the owner's end. */
function connection(): { askerEnd: FakeLink; ownerEnd: FakeLink } {
  const hash = randomBytes(64);
  const askerEnd = new FakeLink(inboxKey, hash);
  const ownerEnd = new FakeLink(asker.publicKey, hash);
  askerEnd.peer = ownerEnd;
  ownerEnd.peer = askerEnd;
  return { askerEnd, ownerEnd };
}

function served() {
  const timers = new ManualTimers();
  const requests: { from: string; nickname: string }[] = [];
  const { askerEnd, ownerEnd } = connection();
  serveInbox(ownerEnd, { key: owner, timers, onRequest: (from, nickname) => requests.push({ from: hexOf(from), nickname }) });
  return { timers, requests, askerEnd, ownerEnd };
}

const send = (link: FakeLink, message: P2pMessage) => link.send(encodeMessage(message));
/** A JSON frame by hand, for bodies encodeMessage would never produce. */
function rawFrame(body: string): Buffer {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
const proof = (link: FakeLink, key = owner) => toBase64Url(signInboxProof(key, link.handshakeHash));

describe('serveInbox: the owner\'s side of an inbox connection (spec §3.2)', () => {
  it('speaks first, proving with the friend key that this very connection reached the owner', () => {
    const { ownerEnd } = served();
    expect(ownerEnd.messages).toHaveLength(1);
    const hello = ownerEnd.messages[0]!;
    expect(hello.t).toBe('inbox.hello');
    if (hello.t !== 'inbox.hello') return;
    expect(verifyInboxProof(owner.publicKey, ownerEnd.handshakeHash, fromBase64Url(hello.sig))).toBe(true);
  });

  it('takes one friend.request, names who asked by the connection\'s key and finishes', () => {
    const { requests, askerEnd, ownerEnd, timers } = served();
    askerEnd.onEnd(() => askerEnd.end());
    send(askerEnd, { t: 'friend.request', nickname: 'Ana' });
    expect(requests).toEqual([{ from: hexOf(asker.publicKey), nickname: 'Ana' }]);
    expect(ownerEnd.ended).toBe(true);
    expect(ownerEnd.closed).toBe(true);
    expect(timers.pending).toBe(0);
  });

  it('drops the connection on a second message', () => {
    const { requests, askerEnd, ownerEnd } = served();
    send(askerEnd, { t: 'friend.request', nickname: 'Ana' });
    send(askerEnd, { t: 'friend.request', nickname: 'Ana de novo' });
    expect(requests).toHaveLength(1);
    expect(ownerEnd.closed).toBe(true);
  });

  it.each<[string, Uint8Array]>([
    ['a request over 1 KiB', rawFrame(`{"t":"friend.request","nickname":"Ana"}${' '.repeat(1024)}`)],
    ['another message', encodeMessage({ t: 'hello', v: 1, nickname: 'Ana' })],
    ['a friend.accept', encodeMessage({ t: 'friend.accept' })],
    ['its own proof echoed back', encodeMessage({ t: 'inbox.hello', sig: 'A'.repeat(86) })],
    ['bytes that are not a frame', Buffer.from('friend.request')],
    ['an empty message', new Uint8Array(0)],
  ])('drops the connection on %s, without a request', (_label, bytes) => {
    const { requests, askerEnd, ownerEnd } = served();
    askerEnd.send(bytes);
    expect(requests).toEqual([]);
    expect(ownerEnd.closed).toBe(true);
    expect(ownerEnd.ended).toBe(false);
  });

  it('closes a connection that says nothing for 10 s', async () => {
    const { ownerEnd, timers } = served();
    await timers.advance(INBOX_TIMEOUT_MS - 1);
    expect(ownerEnd.closed).toBe(false);
    await timers.advance(1);
    expect(ownerEnd.closed).toBe(true);
  });

  it('closes a connection whose other side never finishes', async () => {
    const { askerEnd, ownerEnd, timers } = served();
    send(askerEnd, { t: 'friend.request', nickname: 'Ana' });
    expect(ownerEnd.closed).toBe(false);
    await timers.advance(INBOX_TIMEOUT_MS);
    expect(ownerEnd.closed).toBe(true);
  });

  it('forgets its timer when the connection closes first', () => {
    const { askerEnd, timers } = served();
    askerEnd.close();
    expect(timers.pending).toBe(0);
  });
});

describe('knock: the asker\'s side of an inbox connection (spec §3.2, §5.1)', () => {
  function knocking() {
    const timers = new ManualTimers();
    const { askerEnd, ownerEnd } = connection();
    const result = knock(askerEnd, { friendPub: owner.publicKey, nickname: 'Ana', timers });
    return { timers, askerEnd, ownerEnd, result };
  }

  it('sends the request only after the owner proved itself, and knows it arrived when the owner finishes', async () => {
    const { askerEnd, ownerEnd, result, timers } = knocking();
    expect(askerEnd.sent).toEqual([]);
    send(ownerEnd, { t: 'inbox.hello', sig: proof(ownerEnd) });
    expect(askerEnd.messages).toEqual([{ t: 'friend.request', nickname: 'Ana' }]);
    ownerEnd.end();
    await expect(result).resolves.toBe(true);
    expect(askerEnd.closed).toBe(true);
    expect(timers.pending).toBe(0);
  });

  it.each<[string, (ownerEnd: FakeLink) => void]>([
    ['a proof signed by another key (a fake inbox)', (o) => send(o, { t: 'inbox.hello', sig: proof(o, friendKeyFromSeed(randomBytes(32))) })],
    ['a proof made for another connection (a relayed one)', (o) => send(o, { t: 'inbox.hello', sig: toBase64Url(signInboxProof(owner, randomBytes(64))) })],
    ['a signature over the bare handshake hash', (o) => send(o, { t: 'inbox.hello', sig: toBase64Url(owner.sign(o.handshakeHash)) })],
    ['a request instead of a proof', (o) => send(o, { t: 'friend.request', nickname: 'Eva' })],
    ['a hello instead of a proof', (o) => send(o, { t: 'hello', v: 1, nickname: 'Eva' })],
    ['bytes that are not a frame', (o) => o.send(Buffer.from('oi'))],
    ['a proof padded over 1 KiB', (o) => o.send(rawFrame(JSON.stringify({ t: 'inbox.hello', sig: proof(o) }).padEnd(2048)))],
    ['an end without a proof', (o) => o.end()],
  ])('never sends the request after %s', async (_label, act) => {
    const { askerEnd, ownerEnd, result } = knocking();
    act(ownerEnd);
    await expect(result).resolves.toBe(false);
    expect(askerEnd.sent).toEqual([]);
    expect(askerEnd.closed).toBe(true);
  });

  it('does not count a request as delivered when the connection drops instead of finishing', async () => {
    const { askerEnd, ownerEnd, result } = knocking();
    send(ownerEnd, { t: 'inbox.hello', sig: proof(ownerEnd) });
    expect(askerEnd.sent).toHaveLength(1);
    ownerEnd.close();
    await expect(result).resolves.toBe(false);
  });

  it('drops an owner that keeps talking after its proof', async () => {
    const { askerEnd, ownerEnd, result } = knocking();
    send(ownerEnd, { t: 'inbox.hello', sig: proof(ownerEnd) });
    send(ownerEnd, { t: 'inbox.hello', sig: proof(ownerEnd) });
    await expect(result).resolves.toBe(false);
    expect(askerEnd.closed).toBe(true);
  });

  it('gives up after 10 s of silence', async () => {
    const { askerEnd, result, timers } = knocking();
    await timers.advance(INBOX_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
    expect(askerEnd.closed).toBe(true);
  });

  it('works end to end against serveInbox', async () => {
    const timers = new ManualTimers();
    const requests: string[] = [];
    const { askerEnd, ownerEnd } = connection();
    const result = knock(askerEnd, { friendPub: owner.publicKey, nickname: 'Ana', timers });
    serveInbox(ownerEnd, { key: owner, timers, onRequest: (from, nickname) => requests.push(`${hexOf(from)} ${nickname}`) });
    await expect(result).resolves.toBe(true);
    expect(requests).toEqual([`${hexOf(asker.publicKey)} Ana`]);
    expect(askerEnd.closed && ownerEnd.closed).toBe(true);
    expect(timers.pending).toBe(0);
  });
});

describe('InboxLimiter (spec §3.2: 8 at once, 30 per hour)', () => {
  it('admits 30 connections in an hour, then none until the oldest is an hour old', async () => {
    const timers = new ManualTimers();
    const limiter = new InboxLimiter(() => timers.now);
    for (let i = 0; i < INBOX_MAX_PER_HOUR; i++) {
      expect(limiter.admit(), `connection ${i + 1}`).toBe(true);
      await timers.advance(60_000);
    }
    expect(limiter.admit()).toBe(false);
    await timers.advance(30 * 60_000 - 1);
    expect(limiter.admit()).toBe(false);
    await timers.advance(1);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false);
  });

  it('admits no more while 8 connections are open, and again when one closes', async () => {
    const limiter = new InboxLimiter(() => 0);
    const links: FakeLink[] = [];
    for (let i = 0; i < INBOX_MAX_OPEN; i++) {
      expect(limiter.admit()).toBe(true);
      const [link] = linkPair(randomBytes(32), randomBytes(32));
      expect(limiter.track(link)).toBe(true);
      links.push(link);
    }
    expect(limiter.admit()).toBe(false);
    // Several handshakes can be admitted before any of them opens: the ninth to open is turned away.
    expect(limiter.track(linkPair(randomBytes(32), randomBytes(32))[0])).toBe(false);
    links[3]!.close();
    await flush();
    expect(limiter.admit()).toBe(true);
  });
});
