import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DM_TEXT_MAX } from '../../src/shared/dmTypes.js';
import { dmConversationId, dmMembers, isMember } from '../../src/main/p2p/conversations.js';
import {
  ENTRY_MAX_BYTES,
  ENTRY_MAX_FUTURE_MS,
  checkEntry,
  entryBodyJson,
  entrySchema,
  entrySignedBytes,
  entrySize,
  newMessageId,
  parseEntryBody,
  signEntry,
  verifyEntry,
  type Entry,
  type EntryContext,
} from '../../src/main/p2p/entries.js';
import { friendKeyFromSeed, keyToText } from '../../src/main/p2p/friendKey.js';

const keyOf = (name: string) => friendKeyFromSeed(createHash('sha256').update(name).digest());
const ana = keyOf('Ana');
const bia = keyOf('Bia');
const eva = keyOf('Eva');
const CONV = dmConversationId(ana.publicKey, bia.publicKey);
const NOW = 1_700_000_000_000;
const ID = 'ab'.repeat(16);

function entry(patch: Partial<Omit<Entry, 'author' | 'sig'>> = {}, key = ana): Entry {
  return signEntry(key, { conv: CONV, seq: 1, ts: NOW, kind: 'msg', body: entryBodyJson({ kind: 'msg', id: ID, text: 'oi', replyTo: null, attachments: [] }), ...patch });
}

/** Ana's and Bia's conversation, as Bia's computer sees it: nobody wrote yet. */
function context(patch: Partial<EntryContext> = {}): EntryContext {
  return { conv: CONV, members: dmMembers(ana.publicKey, bia.publicKey), head: () => 0, now: NOW, ...patch };
}

describe('the 1:1 conversation id (friends spec §4.1)', () => {
  it('is hex(SHA-256("ghostlink/dm/v1" ‖ smaller key ‖ bigger key))[0:32], the same on both computers', () => {
    const [low, high] = Buffer.compare(ana.publicKey, bia.publicKey) < 0 ? [ana.publicKey, bia.publicKey] : [bia.publicKey, ana.publicKey];
    const expected = createHash('sha256').update('ghostlink/dm/v1').update(low).update(high).digest('hex').slice(0, 32);
    expect(dmConversationId(ana.publicKey, bia.publicKey)).toBe(expected);
    expect(dmConversationId(bia.publicKey, ana.publicKey)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });

  it('matches the frozen vector', () => {
    expect(dmConversationId(new Uint8Array(32).fill(2), new Uint8Array(32).fill(1))).toBe(
      createHash('sha256').update('ghostlink/dm/v1').update(new Uint8Array(32).fill(1)).update(new Uint8Array(32).fill(2)).digest('hex').slice(0, 32),
    );
    expect(dmConversationId(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe('2636ed8de1e33b1bb787880a1bdcaed0');
  });

  it('orders the keys byte by byte, not as text', () => {
    // 0x7f… < 0x80…: a signed comparison would swap them.
    const a = new Uint8Array(32).fill(0x7f);
    const b = new Uint8Array(32).fill(0x80);
    const expected = createHash('sha256').update('ghostlink/dm/v1').update(a).update(b).digest('hex').slice(0, 32);
    expect(dmConversationId(b, a)).toBe(expected);
  });

  it('is another id for every other pair', () => {
    expect(dmConversationId(ana.publicKey, eva.publicKey)).not.toBe(CONV);
    expect(dmConversationId(bia.publicKey, eva.publicKey)).not.toBe(CONV);
  });

  it('has exactly its two members', () => {
    const members = dmMembers(bia.publicKey, ana.publicKey);
    expect(members.map(keyToText)).toEqual(dmMembers(ana.publicKey, bia.publicKey).map(keyToText));
    expect(isMember(members, ana.publicKey)).toBe(true);
    expect(isMember(members, bia.publicKey)).toBe(true);
    expect(isMember(members, eva.publicKey)).toBe(false);
  });
});

describe('the signed entry (friends spec §4.2)', () => {
  it('signs "ghostlink/entry/v1\\n" ‖ conv ‖ "\\n" ‖ seq ‖ "\\n" ‖ ts ‖ "\\n" ‖ kind ‖ "\\n" ‖ SHA-256(body)', () => {
    const body = '{"id":"x","text":"olá"}';
    const bytes = Buffer.from(entrySignedBytes({ conv: CONV, seq: 12, ts: 1_700_000_000_123, kind: 'edit', body }));
    const head = Buffer.from(`ghostlink/entry/v1\n${CONV}\n12\n1700000000123\nedit\n`, 'utf8');
    expect(bytes.subarray(0, head.length).equals(head)).toBe(true);
    expect(bytes.subarray(head.length).equals(createHash('sha256').update(Buffer.from(body, 'utf8')).digest())).toBe(true);
    expect(bytes.length).toBe(head.length + 32);
  });

  it('carries the author as base64url and the signature as base64url of 64 bytes', () => {
    const e = entry();
    expect(e.author).toBe(keyToText(ana.publicKey));
    expect(e.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(entrySchema.parse(e)).toEqual(e);
    expect(verifyEntry(e)).toBe(true);
  });

  it.each<[string, (e: Entry) => Entry]>([
    ['a tampered body', (e) => ({ ...e, body: e.body.replace('oi', 'tchau') })],
    ['another seq', (e) => ({ ...e, seq: 2 })],
    ['another ts', (e) => ({ ...e, ts: e.ts + 1 })],
    ['another kind', (e) => ({ ...e, kind: 'edit' })],
    ['another conversation', (e) => ({ ...e, conv: dmConversationId(ana.publicKey, eva.publicKey) })],
    ['another author', (e) => ({ ...e, author: keyToText(bia.publicKey) })],
    ['a signature of another entry', (e) => ({ ...e, sig: entry({ seq: 2 }).sig })],
    ['a signature that is not base64url', (e) => ({ ...e, sig: `${e.sig.slice(0, 85)}+` })],
  ])('does not verify with %s', (_label, change) => {
    expect(verifyEntry(change(entry()))).toBe(false);
  });

  it('gives every message its own 16-byte id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newMessageId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('accepting an entry (friends spec §4.2)', () => {
  it('takes the author\'s next entry, signed by a member, from the present', () => {
    expect(checkEntry(entry(), context())).toBe('ok');
    expect(checkEntry(entry({ seq: 4 }, bia), context({ head: (a) => (Buffer.from(a).equals(bia.publicKey) ? 3 : 0) }))).toBe('ok');
    // The other member's entries, relayed back, count too.
    expect(checkEntry(entry({ seq: 1 }), context({ head: (a) => (Buffer.from(a).equals(bia.publicKey) ? 9 : 0) }))).toBe('ok');
  });

  it('refuses a bad signature, whatever else is right', () => {
    expect(checkEntry({ ...entry(), body: entryBodyJson({ kind: 'msg', id: ID, text: 'tchau', replyTo: null, attachments: [] }) }, context())).toBe('bad-signature');
    // Signed by Ana, claimed as Bia's.
    expect(checkEntry({ ...entry(), author: keyToText(bia.publicKey) }, context())).toBe('bad-signature');
  });

  it('refuses an author who is not a member, even with a good signature', () => {
    expect(checkEntry(entry({}, eva), context())).toBe('not-member');
  });

  it('refuses an entry of another conversation', () => {
    expect(checkEntry(entry({ conv: dmConversationId(ana.publicKey, eva.publicKey) }), context())).toBe('other-conv');
  });

  it('refuses a gap in seq and an entry it already has', () => {
    expect(checkEntry(entry({ seq: 2 }), context())).toBe('gap');
    expect(checkEntry(entry({ seq: 5 }), context({ head: () => 3 }))).toBe('gap');
    expect(checkEntry(entry({ seq: 3 }), context({ head: () => 3 }))).toBe('duplicate');
    expect(checkEntry(entry({ seq: 1 }), context({ head: () => 3 }))).toBe('duplicate');
  });

  it('takes a ts up to 5 minutes ahead of the local clock and refuses one later', () => {
    expect(ENTRY_MAX_FUTURE_MS).toBe(5 * 60_000);
    expect(checkEntry(entry({ ts: NOW + ENTRY_MAX_FUTURE_MS }), context())).toBe('ok');
    expect(checkEntry(entry({ ts: NOW + ENTRY_MAX_FUTURE_MS + 1 }), context())).toBe('future');
    // The past is fine: the message was written while the friend was away.
    expect(checkEntry(entry({ ts: NOW - 30 * 86_400_000 }), context())).toBe('ok');
  });

  it('refuses an entry over 64 KiB', () => {
    expect(ENTRY_MAX_BYTES).toBe(64 * 1024);
    const fits = (size: number) => entry({ kind: 'delete', body: `{"id":"${ID}","pad":"${'x'.repeat(size)}"}` });
    let pad = ENTRY_MAX_BYTES - entrySize(fits(0));
    expect(entrySize(fits(pad))).toBe(ENTRY_MAX_BYTES);
    expect(checkEntry(fits(pad), context())).toBe('ok');
    pad += 1;
    expect(checkEntry(fits(pad), context())).toBe('too-large');
  });
});

describe('entry bodies (friends spec §4.2)', () => {
  it('builds and reads msg, edit and delete', () => {
    for (const body of [
      { kind: 'msg', id: ID, text: 'oi', replyTo: null, attachments: [] },
      { kind: 'msg', id: ID, text: 'resposta', replyTo: 'cd'.repeat(16), attachments: [] },
      { kind: 'edit', id: ID, text: 'oi!' },
      { kind: 'delete', id: ID },
    ] as const) {
      expect(parseEntryBody(body.kind, entryBodyJson(body))).toEqual(body);
    }
    expect(JSON.parse(entryBodyJson({ kind: 'msg', id: ID, text: 'oi', replyTo: null, attachments: [] }))).toEqual({ id: ID, text: 'oi', attachments: [] });
  });

  it('takes text up to 4000 characters', () => {
    expect(parseEntryBody('msg', JSON.stringify({ id: ID, text: 'x'.repeat(DM_TEXT_MAX), attachments: [] }))).not.toBeNull();
    expect(parseEntryBody('msg', JSON.stringify({ id: ID, text: 'x'.repeat(DM_TEXT_MAX + 1), attachments: [] }))).toBeNull();
    expect(parseEntryBody('edit', JSON.stringify({ id: ID, text: 'x'.repeat(DM_TEXT_MAX + 1) }))).toBeNull();
  });

  it.each<[string, 'msg' | 'edit' | 'delete', string]>([
    ['not JSON', 'msg', '{"id":'],
    ['an array', 'msg', '[]'],
    ['an empty text', 'msg', JSON.stringify({ id: ID, text: '', attachments: [] })],
    ['a blank text', 'edit', JSON.stringify({ id: ID, text: ' \n ' })],
    ['an id that is not 32 hex characters', 'msg', JSON.stringify({ id: 'AB'.repeat(16), text: 'oi', attachments: [] })],
    ['a reply to something that is not an id', 'msg', JSON.stringify({ id: ID, text: 'oi', replyTo: 'x', attachments: [] })],
    ['a null reply (absent means none)', 'msg', JSON.stringify({ id: ID, text: 'oi', replyTo: null, attachments: [] })],
    ['attachments (files come with phase 3)', 'msg', JSON.stringify({ id: ID, text: 'oi', attachments: [{ hash: 'x' }] })],
    ['no attachments list', 'msg', JSON.stringify({ id: ID, text: 'oi' })],
    ['an extra key', 'msg', JSON.stringify({ id: ID, text: 'oi', attachments: [], admin: true })],
    ['an edit without text', 'edit', JSON.stringify({ id: ID })],
    ['a delete with text', 'delete', JSON.stringify({ id: ID, text: 'oi' })],
  ])('reads nothing from %s', (_label, kind, body) => {
    expect(parseEntryBody(kind, body)).toBeNull();
  });
});

describe('the entry on the wire', () => {
  it.each<[string, (e: Entry) => unknown]>([
    ['seq 0', (e) => ({ ...e, seq: 0 })],
    ['a fractional seq', (e) => ({ ...e, seq: 1.5 })],
    ['a seq as text', (e) => ({ ...e, seq: '1' })],
    ['a negative ts', (e) => ({ ...e, ts: -1 })],
    ['an unsafe integer', (e) => ({ ...e, ts: 2 ** 53 })],
    ['an unknown kind', (e) => ({ ...e, kind: 'group.create' })],
    ['an author that is not a key', (e) => ({ ...e, author: 'x' })],
    ['an uppercase conversation id', (e) => ({ ...e, conv: e.conv.toUpperCase() })],
    ['a body with a lone surrogate', (e) => ({ ...e, body: '\uD800' })],
    ['a body that is not a string', (e) => ({ ...e, body: { id: ID } })],
    ['an extra key', (e) => ({ ...e, relayedBy: 'x' })],
    ['no signature', ({ sig: _sig, ...rest }) => rest],
  ])('refuses %s', (_label, change) => {
    expect(entrySchema.safeParse(change(entry())).success).toBe(false);
  });
});
