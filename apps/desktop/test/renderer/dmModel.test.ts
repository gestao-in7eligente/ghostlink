import { describe, expect, it } from 'vitest';
import type { DmAttachment, DmConversation, DmMessage } from '../../src/shared/dmTypes.js';
import {
  applyConversation,
  applyFile,
  applyMessage,
  buildDmRows,
  dmAttachmentViews,
  dmSummary,
  DM_CONV_ID,
  isTyping,
  mergeHistory,
  plainDm,
  repliedMessage,
  sidebarConversations,
  totalUnread,
} from '../../src/renderer/features/dm/dmModel.js';

describe('plainDm and DM_CONV_ID', () => {
  it('turns a message into one line of text for reply previews', () => {
    expect(plainDm('**oi**  _tudo_\nbem? `x`')).toBe('oi tudo bem? x');
    expect(plainDm('```\ncode\n```')).toBe('code');
  });

  it('tells a conversation id from a server channel id', () => {
    expect(DM_CONV_ID.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(DM_CONV_ID.test('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(false);
    expect(DM_CONV_ID.test('0123456789ABCDEF0123456789ABCDEF')).toBe(false);
  });
});

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
  attachments: [],
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

describe('files of a message (attachments spec §1, §3)', () => {
  const HASH = 'ab'.repeat(32);
  const URL_OF = `app://ghostlink/_dmfile/${HASH}`;
  const file = (over: Partial<DmAttachment> = {}): DmAttachment => ({ hash: HASH, name: 'foto.png', size: 1000, kind: 'image', mime: 'image/png', width: 4, height: 3, state: 'absent', received: 0, ...over });
  const notes = { waiting: 'Chega quando Bia estiver online', arriving: 'Carregando…', loading: (p: number) => `Recebendo… ${p}%` };
  const view = (f: DmAttachment, online = true) => dmAttachmentViews([f], online, notes)[0]!;

  it('shows a file that is here from app://ghostlink/_dmfile', () => {
    expect(view(file({ state: 'ready', received: 1000 }))).toEqual({ key: HASH, name: 'foto.png', size: 1000, kind: 'image', mime: 'image/png', width: 4, height: 3, src: URL_OF });
  });

  it('says when a file that is not here will come', () => {
    expect(view(file(), false)).toMatchObject({ kind: 'image', src: null, note: 'Chega quando Bia estiver online' });
    expect(view(file({ kind: 'file', mime: 'application/pdf' }), false)).toMatchObject({ kind: 'file', src: null, note: 'Chega quando Bia estiver online' });
    expect(view(file())).toMatchObject({ kind: 'image', src: null, note: 'Carregando…' });
    expect(view(file({ state: 'loading', received: 400 }))).toMatchObject({ kind: 'image', src: null, note: 'Recebendo… 40%' });
  });

  it('turns what needs a click into a card whose Baixar works', () => {
    for (const f of [file({ size: 6 * 1024 * 1024 }), file({ kind: 'video', mime: 'video/mp4' }), file({ state: 'failed' })]) {
      expect(view(f)).toMatchObject({ kind: 'file', src: URL_OF });
      expect(view(f).note).toBeUndefined();
    }
  });

  it('moves a file in every loaded message that carries it, and nothing else', () => {
    const one = msg('a', 'me', 1, { attachments: [file()] });
    const two = msg('b', 'peer', 2, { attachments: [file({ hash: 'cd'.repeat(32) })] });
    const list = [one, two];
    const next = applyFile(list, HASH, 'ready', 1000);
    expect(next[0]!.attachments[0]).toMatchObject({ state: 'ready', received: 1000 });
    expect(next[1]).toBe(two);
    expect(applyFile(list, 'ef'.repeat(32), 'ready', 1)).toBe(list);
    expect(dmSummary({ text: '', attachments: [file(), file({ name: 'nota.pdf' })] })).toBe('foto.png, nota.pdf');
  });
});
