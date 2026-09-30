import { describe, expect, it } from 'vitest';
import type { DmConversation, DmMessage } from '../../src/shared/dmTypes.js';
import {
  applyConversation,
  applyMessage,
  buildDmRows,
  isTyping,
  mergeHistory,
  repliedMessage,
  sidebarConversations,
  totalUnread,
} from '../../src/renderer/features/dm/dmModel.js';

const MIN = 60_000;
const NOON = new Date(2026, 8, 30, 12, 0, 0).getTime();

const msg = (id: string, author: string, ts: number, over: Partial<DmMessage> = {}): DmMessage => ({
  id,
  conv: 'c1',
  author,
  mine: author === 'me',
  ts,
  text: id,
  replyTo: null,
  editedAt: null,
  deleted: false,
  delivered: true,
  ...over,
});

const conv = (id: string, over: Partial<DmConversation> = {}): DmConversation => ({ id, kind: 'dm', peer: `peer-${id}`, lastTs: null, lastText: null, unread: 0, hidden: false, ...over });

describe('conversation rows', () => {
  it('starts with the day and groups one author within 5 minutes', () => {
    const rows = buildDmRows([msg('a', 'me', NOON), msg('b', 'me', NOON + MIN), msg('c', 'ana', NOON + 2 * MIN), msg('d', 'ana', NOON + 8 * MIN)]);
    expect(rows.map((r) => (r.kind === 'date' ? 'date' : `${r.message.id}:${r.head}`))).toEqual(['date', 'a:true', 'b:false', 'c:true', 'd:true']);
  });

  it('starts a group on a reply and on a new day', () => {
    const nextDay = NOON + 24 * 60 * MIN;
    const rows = buildDmRows([msg('a', 'me', NOON), msg('b', 'me', NOON + MIN, { replyTo: 'a' }), msg('c', 'me', nextDay)]);
    expect(rows.map((r) => (r.kind === 'date' ? 'date' : `${r.message.id}:${r.head}`))).toEqual(['date', 'a:true', 'b:true', 'date', 'c:true']);
  });
});

describe('messages from main', () => {
  const list = [msg('a', 'me', NOON), msg('c', 'ana', NOON + 2 * MIN)];

  it('places a new message by its time, even when it arrives late', () => {
    expect(applyMessage(list, msg('b', 'ana', NOON + MIN)).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(applyMessage(list, msg('d', 'me', NOON + 3 * MIN)).map((m) => m.id)).toEqual(['a', 'c', 'd']);
  });

  it('replaces a message that changed instead of adding it again', () => {
    const edited = applyMessage(list, msg('a', 'me', NOON, { text: 'novo', editedAt: NOON + 5 }));
    expect(edited).toHaveLength(2);
    expect(edited[0]).toMatchObject({ text: 'novo', editedAt: NOON + 5 });
  });

  it('joins an older page without repeating messages', () => {
    const merged = mergeHistory(list, [msg('z', 'ana', NOON - MIN), msg('a', 'me', NOON)]);
    expect(merged.map((m) => m.id)).toEqual(['z', 'a', 'c']);
  });

  it('finds the replied message only among the loaded ones', () => {
    expect(repliedMessage(list, 'c')?.id).toBe('c');
    expect(repliedMessage(list, 'gone')).toBeNull();
    expect(repliedMessage(list, null)).toBeNull();
  });
});

describe('sidebar', () => {
  const list = [conv('old', { lastTs: 10, unread: 2 }), conv('empty'), conv('new', { lastTs: 50, unread: 1 }), conv('closed', { lastTs: 99, hidden: true, unread: 4 })];

  it('shows the open conversations, newest first, empty ones last', () => {
    expect(sidebarConversations(list).map((c) => c.id)).toEqual(['new', 'old', 'empty']);
  });

  it('adds a new conversation and replaces a changed one', () => {
    expect(applyConversation(list, conv('x')).map((c) => c.id)).toEqual(['old', 'empty', 'new', 'closed', 'x']);
    expect(applyConversation(list, conv('old', { unread: 0 }))[0]!.unread).toBe(0);
  });

  it('adds up the unread messages, closed conversations included', () => {
    expect(totalUnread(list)).toBe(7);
  });
});

describe('typing', () => {
  it('lasts 5 seconds after the last signal', () => {
    expect(isTyping(1_000, 5_999)).toBe(true);
    expect(isTyping(1_000, 6_000)).toBe(false);
    expect(isTyping(undefined, 6_000)).toBe(false);
  });
});
