import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, CHAT_LIMITS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { parseTextEvent, snapshotFromWelcome } from '../../src/renderer/features/chat/events.js';
import { isUnread, readMark, sortedChannels } from '../../src/renderer/stores/channels.js';
import { groupMembers } from '../../src/renderer/stores/members.js';
import { INACTIVE_KEEP, typingUserIds } from '../../src/renderer/stores/messages.js';
import { canActOnMember, manageableRoles, myPermissions, rolesByPosition } from '../../src/renderer/stores/server.js';
import { initialText, textReducer } from '../../src/renderer/stores/text.js';
import {
  ADMIN_ROLE,
  BOB,
  CAROL,
  EVERYONE_ROLE,
  FANS_ROLE,
  GERAL,
  ME,
  MOD_ROLE,
  NOW,
  OWNER,
  RANDOM,
  SECRET,
  VOICE,
  channel,
  ev,
  loaded,
  member,
  message,
  run,
  snapshot,
  start,
  welcomeWithText,
} from './textFixtures.js';

const log = (s: ReturnType<typeof start>, id = GERAL) => s.messages.logs[id]!;
const ids = (s: ReturnType<typeof start>, id = GERAL) => log(s, id).items.map((m) => m.id);

describe('welcome snapshot', () => {
  it('reads the text keys that ride along on the renderer welcome', () => {
    const snap = snapshotFromWelcome(welcomeWithText());
    expect(snap).toEqual(snapshot());
  });

  it('defaults every missing or malformed text key instead of failing', () => {
    const w = { ...welcomeWithText(), channels: 'nope', roles: undefined, members: [{ junk: true }] };
    const snap = snapshotFromWelcome(w);
    expect(snap.text).toMatchObject({ channels: [], roles: [], members: [], readStates: expect.any(Array) });
    expect(snap.self.userId).toBe(ME);
  });
});

describe('reset (welcome)', () => {
  it('lands a new member in the first text channel, #geral', () => {
    const s = start();
    expect(s.channels.activeId).toBe(GERAL);
    expect(s.channels.stageId).toBeNull();
    expect(sortedChannels(s.channels.byId, 'text').map((c) => c.name)).toEqual(['geral', 'random']);
    expect(s.server).toMatchObject({ serverId: 'srv-1', selfId: ME, name: 'Casa', ownerId: OWNER, maxMembers: 100 });
    expect(Object.keys(s.members.byId)).toHaveLength(4);
  });

  it('computes unread from lastMessageId > lastReadMessageId and keeps mention counts', () => {
    const s = start();
    expect(isUnread(s.channels.byId[GERAL]!, readMark(s.channels, GERAL))).toBe(false);
    expect(isUnread(s.channels.byId[RANDOM]!, readMark(s.channels, RANDOM))).toBe(true);
    expect(readMark(s.channels, RANDOM).mentionCount).toBe(1);
    expect(isUnread(s.channels.byId[VOICE]!, readMark(s.channels, VOICE))).toBe(false);
  });

  it('a reconnect to the same server keeps the open channel and drops loaded messages', () => {
    const s = run(loaded(), { type: 'select', channelId: RANDOM }, { type: 'reset', snapshot: snapshot() });
    expect(s.channels.activeId).toBe(RANDOM);
    expect(s.messages.logs).toEqual({});
  });

  it('falls back to #geral when the open channel is gone or the server changed', () => {
    const gone = run(start(), { type: 'select', channelId: RANDOM }, { type: 'reset', snapshot: snapshot({ channels: [channel(GERAL, 'geral', 0)] }) });
    expect(gone.channels.activeId).toBe(GERAL);
    const other = run(start(), { type: 'select', channelId: RANDOM }, { type: 'reset', snapshot: snapshot({}, 'srv-2') });
    expect(other.channels.activeId).toBe(GERAL);
  });

  it('opens nothing when no text channel is visible', () => {
    expect(start(snapshot({ channels: [] })).channels.activeId).toBeNull();
  });

  it('uses self.isOwner when the text module sends no owner', () => {
    const snap = snapshot({ serverSettings: { ownerId: null, maxMembers: 1, hasPassword: false } });
    snap.self.isOwner = true;
    expect(start(snap).server.ownerId).toBe(ME);
  });
});

describe('channel events', () => {
  it('channel.created adds the channel with its read state', () => {
    const c = channel(SECRET, 'segredo', 5, { private: true, lastMessageId: 4 });
    const s = run(start(), ev({ t: 'channel.created', channel: c, readState: { channelId: SECRET, lastReadMessageId: 0, mentionCount: 2 } }));
    expect(s.channels.byId[SECRET]).toEqual(c);
    expect(readMark(s.channels, SECRET)).toEqual({ lastReadMessageId: 0, mentionCount: 2 });
    expect(s.channels.activeId).toBe(GERAL);
  });

  it('channel.created opens the channel when none was open', () => {
    const s = run(start(snapshot({ channels: [] })), ev({ t: 'channel.created', channel: channel(GERAL, 'geral', 0), readState: null }));
    expect(s.channels.activeId).toBe(GERAL);
  });

  it('channel.updated never reveals an unknown channel (visibility arrives as channel.created)', () => {
    const s0 = start();
    expect(run(s0, ev({ t: 'channel.updated', channel: channel(SECRET, 'segredo', 5) }))).toBe(s0);
    const s = run(s0, ev({ t: 'channel.updated', channel: { ...s0.channels.byId[GERAL]!, name: 'praça', topic: 'oi' } }));
    expect(s.channels.byId[GERAL]).toMatchObject({ name: 'praça', topic: 'oi' });
  });

  it('channel.deleted drops the channel, its messages and typing, and moves off it', () => {
    const s = run(loaded(), ev({ t: 'typing', channelId: GERAL, userId: BOB }), ev({ t: 'channel.deleted', id: GERAL }));
    expect(s.channels.byId[GERAL]).toBeUndefined();
    expect(s.channels.reads[GERAL]).toBeUndefined();
    expect(s.messages.logs[GERAL]).toBeUndefined();
    expect(s.messages.typing[GERAL]).toBeUndefined();
    expect(s.channels.activeId).toBe(RANDOM);
  });

  it('select opens text channels only; stage shows voice channels only', () => {
    const s = start();
    expect(run(s, { type: 'select', channelId: VOICE })).toBe(s);
    expect(run(s, { type: 'select', channelId: 'X'.repeat(26) })).toBe(s);
    const staged = run(s, { type: 'stage', channelId: VOICE });
    expect(staged.channels.stageId).toBe(VOICE);
    expect(run(staged, { type: 'stage', channelId: GERAL }).channels.stageId).toBe(VOICE);
    expect(run(staged, { type: 'select', channelId: RANDOM }).channels).toMatchObject({ activeId: RANDOM, stageId: null });
  });
});

describe('messages', () => {
  it('history loads a page oldest first and older pages go in front', () => {
    let s = loaded();
    expect(ids(s)).toEqual([8, 9, 10]);
    expect(log(s)).toMatchObject({ status: 'ready', hasMore: true, older: 'idle' });
    s = run(s, { type: 'history.start', channelId: GERAL, older: true });
    expect(log(s).older).toBe('loading');
    s = run(s, { type: 'history.done', channelId: GERAL, older: true, messages: [message(5), message(7)], hasMore: false });
    expect(ids(s)).toEqual([5, 7, 8, 9, 10]);
    expect(log(s)).toMatchObject({ hasMore: false, older: 'idle' });
  });

  it('a live message that raced the first page is kept, and its newer copy wins', () => {
    let s = run(start(), { type: 'history.start', channelId: GERAL, older: false });
    expect(log(s).status).toBe('loading');
    s = run(s, ev({ t: 'msg.new', message: message(11) }), ev({ t: 'msg.updated', message: message(11, { content: 'editada' }) }));
    s = run(s, { type: 'history.done', channelId: GERAL, older: false, messages: [message(10), message(11)], hasMore: false });
    expect(ids(s)).toEqual([10, 11]);
    expect(log(s).items[1]!.content).toBe('editada');
  });

  it('a failed page is reported per kind', () => {
    let s = run(start(), { type: 'history.start', channelId: GERAL, older: false }, { type: 'history.fail', channelId: GERAL, older: false });
    expect(log(s).status).toBe('error');
    s = run(loaded(), { type: 'history.fail', channelId: GERAL, older: true });
    expect(log(s)).toMatchObject({ status: 'ready', older: 'error' });
  });

  it('msg.new appends to a loaded channel, deduplicates, and is ignored for channels never opened', () => {
    let s = run(loaded(), ev({ t: 'msg.new', message: message(11) }), ev({ t: 'msg.new', message: message(11) }));
    expect(ids(s)).toEqual([8, 9, 10, 11]);
    s = run(s, ev({ t: 'msg.new', message: message(12, { channelId: RANDOM }) }));
    expect(s.messages.logs[RANDOM]).toBeUndefined();
    expect(s.channels.byId[RANDOM]!.lastMessageId).toBe(12);
  });

  it('replaces the pending copy of my own message by clientMsgId', () => {
    const pending = { clientMsgId: 'mine-1', channelId: GERAL, content: 'oi', replyTo: null, createdAt: NOW, error: null };
    let s = run(loaded(), { type: 'pending.add', pending });
    expect(log(s).pending).toHaveLength(1);
    s = run(s, ev({ t: 'msg.new', message: message(11, { authorId: ME, clientMsgId: 'mine-1', content: 'oi' }) }));
    expect(log(s).pending).toEqual([]);
    expect(ids(s)).toEqual([8, 9, 10, 11]);
    // The msg.send answer after the event changes nothing more.
    expect(run(s, { type: 'message.upsert', message: message(11, { authorId: ME, clientMsgId: 'mine-1', content: 'oi' }) }).messages.logs[GERAL]!.items).toHaveLength(4);
  });

  it("someone else's message with my clientMsgId never removes my pending copy", () => {
    const pending = { clientMsgId: 'mine-1', channelId: GERAL, content: 'oi', replyTo: null, createdAt: NOW, error: null };
    const s = run(loaded(), { type: 'pending.add', pending }, ev({ t: 'msg.new', message: message(11, { authorId: BOB, clientMsgId: 'mine-1' }) }));
    expect(log(s).pending).toHaveLength(1);
  });

  it('a failed send keeps the text with the error until retried or dropped', () => {
    const pending = { clientMsgId: 'x1', channelId: GERAL, content: 'oi', replyTo: null, createdAt: NOW, error: null };
    let s = run(loaded(), { type: 'pending.add', pending }, { type: 'pending.fail', channelId: GERAL, clientMsgId: 'x1', error: 'RATE_LIMITED' });
    expect(log(s).pending[0]).toMatchObject({ content: 'oi', error: 'RATE_LIMITED' });
    s = run(s, { type: 'pending.retry', channelId: GERAL, clientMsgId: 'x1' });
    expect(log(s).pending[0]!.error).toBeNull();
    s = run(s, { type: 'pending.drop', channelId: GERAL, clientMsgId: 'x1' });
    expect(log(s).pending).toEqual([]);
  });

  it('msg.updated and msg.deleted update the message and every reply quoting it', () => {
    let s = run(loaded(), ev({ t: 'msg.new', message: message(11, { replyTo: { id: 9, authorId: BOB, content: 'mensagem 9', deleted: false } }) }));
    s = run(s, ev({ t: 'msg.updated', message: message(9, { content: 'novo texto', editedAt: NOW }) }));
    expect(log(s).items.find((m) => m.id === 9)!.content).toBe('novo texto');
    expect(log(s).items.find((m) => m.id === 11)!.replyTo).toMatchObject({ content: 'novo texto', deleted: false });
    s = run(s, ev({ t: 'msg.deleted', id: 9, channelId: GERAL }));
    expect(ids(s)).toEqual([8, 10, 11]);
    expect(log(s).items.find((m) => m.id === 11)!.replyTo).toMatchObject({ content: '', deleted: true });
  });

  it('msg.reactions replaces the reactions of a loaded message', () => {
    const reactions = [{ emoji: '👍', userIds: [BOB, ME] }];
    const s = run(loaded(), ev({ t: 'msg.reactions', id: 10, channelId: GERAL, reactions }));
    expect(log(s).items.at(-1)!.reactions).toEqual(reactions);
    const same = loaded();
    expect(run(same, ev({ t: 'msg.reactions', id: 99, channelId: GERAL, reactions })).messages).toBe(same.messages);
  });

  it('an older page that arrives after the log was trimmed is dropped (no gap in the history)', () => {
    const many = Array.from({ length: INACTIVE_KEEP + 30 }, (_, i) => message(i + 101));
    let s = run(start(), { type: 'history.done', channelId: GERAL, older: false, messages: many, hasMore: true });
    s = run(s, { type: 'history.start', channelId: GERAL, older: true }); // before = 101
    s = run(s, { type: 'select', channelId: RANDOM }); // trimmed: the first message is now 131
    s = run(s, { type: 'history.done', channelId: GERAL, older: true, before: 101, messages: [message(90), message(100)], hasMore: true });
    expect(ids(s)[0]).toBe(131);
    expect(ids(s)).not.toContain(100);
    expect(log(s).older).toBe('idle');
  });

  it('a rejected channel switch never trims the open channel', () => {
    const many = Array.from({ length: INACTIVE_KEEP + 30 }, (_, i) => message(i + 1));
    let s = run(start(), { type: 'history.done', channelId: GERAL, older: false, messages: many, hasMore: false });
    s = run(s, { type: 'select', channelId: 'Q'.repeat(26) }, { type: 'select', channelId: VOICE });
    expect(s.channels.activeId).toBe(GERAL);
    expect(log(s).items).toHaveLength(INACTIVE_KEEP + 30);
  });

  it('a reconnect keeps unsent messages; the channel reloads its history', () => {
    const pending = { clientMsgId: 'x1', channelId: GERAL, content: 'não perca isto', replyTo: null, createdAt: NOW, error: 'CONNECTION_LOST' as const };
    let s = run(loaded(), { type: 'pending.add', pending }, { type: 'reset', snapshot: snapshot() });
    expect(log(s)).toMatchObject({ items: [], status: 'stale', pending: [pending] });
    expect(s.messages.logs[RANDOM]).toBeUndefined();
    s = run(s, { type: 'history.start', channelId: GERAL, older: false }, { type: 'history.done', channelId: GERAL, older: false, messages: [message(10)], hasMore: false });
    expect(log(s)).toMatchObject({ status: 'ready', pending: [pending] });
    // Another server's welcome drops them.
    expect(run(s, { type: 'reset', snapshot: snapshot({}, 'srv-2') }).messages.logs).toEqual({});
  });

  it('a channel left open in the background never grows past the newest messages', () => {
    let s = run(loaded(), { type: 'select', channelId: RANDOM });
    s = run(s, { type: 'history.done', channelId: RANDOM, older: false, messages: [message(7, { channelId: RANDOM })], hasMore: false });
    // A busy #geral while the user reads #random (msg.new, and my own sends from elsewhere).
    for (let id = 11; id <= 10 + INACTIVE_KEEP * 3; id++) s = run(s, ev({ t: 'msg.new', message: message(id) }));
    s = run(s, { type: 'message.upsert', message: message(10 + INACTIVE_KEEP * 3 + 1, { authorId: ME }) });
    expect(log(s).items).toHaveLength(INACTIVE_KEEP);
    expect(ids(s).at(-1)).toBe(10 + INACTIVE_KEEP * 3 + 1);
    expect(log(s)).toMatchObject({ hasMore: true, older: 'idle' });
    // The open channel keeps everything it loaded.
    for (let id = 1_000; id < 1_000 + INACTIVE_KEEP + 5; id++) s = run(s, ev({ t: 'msg.new', message: message(id, { channelId: RANDOM }) }));
    expect(log(s, RANDOM).items).toHaveLength(INACTIVE_KEEP + 6);
  });

  it('leaving a channel trims its log to the newest messages', () => {
    const many = Array.from({ length: INACTIVE_KEEP + 30 }, (_, i) => message(i + 1));
    let s = run(start(), { type: 'history.done', channelId: GERAL, older: false, messages: many, hasMore: false });
    s = run(s, { type: 'select', channelId: RANDOM });
    expect(log(s).items).toHaveLength(INACTIVE_KEEP);
    expect(log(s).items[0]!.id).toBe(31);
    expect(log(s).hasMore).toBe(true);
  });
});

describe('unread and mentions', () => {
  it('a message in another channel makes it unread; a mention of me counts', () => {
    let s = run(start(), ev({ t: 'msg.new', message: message(20, { channelId: GERAL }) }));
    expect(isUnread(s.channels.byId[GERAL]!, readMark(s.channels, GERAL))).toBe(true);
    expect(readMark(s.channels, GERAL).mentionCount).toBe(0);
    s = run(s, ev({ t: 'msg.new', message: message(21, { mentions: { users: [ME], roles: [], everyone: false } }) }));
    s = run(s, ev({ t: 'msg.new', message: message(22, { mentions: { users: [], roles: [FANS_ROLE], everyone: false } }) }));
    s = run(s, ev({ t: 'msg.new', message: message(23, { mentions: { users: [], roles: [], everyone: true } }) }));
    s = run(s, ev({ t: 'msg.new', message: message(24, { mentions: { users: [BOB], roles: [MOD_ROLE], everyone: false } }) }));
    expect(readMark(s.channels, GERAL).mentionCount).toBe(3);
  });

  it('my own messages are read at once and never count as mentions', () => {
    const s = run(start(), ev({ t: 'msg.new', message: message(20, { authorId: ME, mentions: { users: [ME], roles: [], everyone: true } }) }));
    expect(readMark(s.channels, GERAL)).toEqual({ lastReadMessageId: 20, mentionCount: 0 });
    expect(isUnread(s.channels.byId[GERAL]!, readMark(s.channels, GERAL))).toBe(false);
  });

  it('a mention on screen (open, focused, at the bottom) does not count; channel.read moves the mark', () => {
    let s = run(start(), { type: 'attention', attentive: true }, ev({ t: 'msg.new', message: message(20, { mentions: { users: [ME], roles: [], everyone: false } }) }));
    // The mark stays for the UI to send channel.read (so the server learns it), which then moves it.
    expect(readMark(s.channels, GERAL)).toEqual({ lastReadMessageId: 10, mentionCount: 0 });
    expect(s.channels.byId[GERAL]!.lastMessageId).toBe(20);
    s = run(s, { type: 'read', readState: { channelId: GERAL, lastReadMessageId: 20, mentionCount: 0 } });
    expect(isUnread(s.channels.byId[GERAL]!, readMark(s.channels, GERAL))).toBe(false);
    s = run(s, { type: 'attention', attentive: false }, ev({ t: 'msg.new', message: message(21, { mentions: { users: [ME], roles: [], everyone: false } }) }));
    expect(readMark(s.channels, GERAL)).toEqual({ lastReadMessageId: 20, mentionCount: 1 });
  });

  it('the voice stage over the chat means the chat is not on screen', () => {
    const s = run(start(), { type: 'attention', attentive: true }, { type: 'stage', channelId: VOICE }, ev({ t: 'msg.new', message: message(20) }));
    expect(isUnread(s.channels.byId[GERAL]!, readMark(s.channels, GERAL))).toBe(true);
  });

  it('editing a mention in or out of an unread message adjusts the count; deleting it removes it', () => {
    let s = run(loaded(), ev({ t: 'msg.new', message: message(11) }));
    s = run(s, ev({ t: 'msg.updated', message: message(11, { mentions: { users: [ME], roles: [], everyone: false } }) }));
    expect(readMark(s.channels, GERAL).mentionCount).toBe(1);
    s = run(s, ev({ t: 'msg.deleted', id: 11, channelId: GERAL }));
    expect(readMark(s.channels, GERAL).mentionCount).toBe(0);
    s = run(s, ev({ t: 'msg.deleted', id: 11, channelId: GERAL }));
    expect(readMark(s.channels, GERAL).mentionCount).toBe(0);
  });

  it('a read mark only moves forward; the server answer sets the mention count', () => {
    let s = run(start(), { type: 'read', readState: { channelId: RANDOM, lastReadMessageId: 7, mentionCount: 0 } });
    expect(readMark(s.channels, RANDOM)).toEqual({ lastReadMessageId: 7, mentionCount: 0 });
    s = run(s, { type: 'read', readState: { channelId: RANDOM, lastReadMessageId: 2, mentionCount: 0 } });
    expect(readMark(s.channels, RANDOM).lastReadMessageId).toBe(7);
    const same = run(s, { type: 'read', readState: { channelId: SECRET, lastReadMessageId: 9, mentionCount: 0 } });
    expect(same).toBe(s);
  });
});

describe('typing', () => {
  it('shows others for a few seconds, never me, and a message clears it', () => {
    let s = run(start(), ev({ t: 'typing', channelId: GERAL, userId: BOB }, NOW), ev({ t: 'typing', channelId: GERAL, userId: ME }, NOW));
    expect(typingUserIds(s.messages, GERAL, NOW + 1)).toEqual([BOB]);
    expect(typingUserIds(s.messages, GERAL, NOW + CHAT_LIMITS.typingTtlMs)).toEqual([]);
    s = run(s, ev({ t: 'msg.new', message: message(20, { authorId: BOB }) }));
    expect(typingUserIds(s.messages, GERAL, NOW + 1)).toEqual([]);
  });

  it('prunes expired entries', () => {
    const s = run(start(), ev({ t: 'typing', channelId: GERAL, userId: BOB }, NOW), { type: 'typing.prune', now: NOW + CHAT_LIMITS.typingTtlMs + 1 });
    expect(s.messages.typing).toEqual({});
  });
});

describe('members and roles', () => {
  it('join, update, presence and leave', () => {
    let s = run(start(), ev({ t: 'member.joined', member: member('e'.repeat(32), 'Eva') }));
    expect(s.members.byId['e'.repeat(32)]!.nickname).toBe('Eva');
    s = run(s, ev({ t: 'member.updated', member: member(BOB, 'Roberto') }), ev({ t: 'presence', userId: CAROL, online: true }));
    expect(s.members.byId[BOB]!.nickname).toBe('Roberto');
    expect(s.members.byId[CAROL]!.online).toBe(true);
    s = run(s, ev({ t: 'typing', channelId: GERAL, userId: BOB }), ev({ t: 'member.left', userId: BOB, reason: 'kicked' }));
    expect(s.members.byId[BOB]).toBeUndefined();
    expect(typingUserIds(s.messages, GERAL, NOW)).toEqual([]);
  });

  it('role events update the roles and a deleted role leaves every member', () => {
    let s = run(start(), ev({ t: 'role.updated', role: { ...start().server.roles[FANS_ROLE]!, name: 'Fã-clube' } }));
    expect(s.server.roles[FANS_ROLE]!.name).toBe('Fã-clube');
    s = run(s, ev({ t: 'role.deleted', id: FANS_ROLE }));
    expect(s.server.roles[FANS_ROLE]).toBeUndefined();
    expect(s.members.byId[ME]!.roleIds).toEqual([]);
  });

  it('server.updated patches name, mode, owner and limits', () => {
    const s = run(start(), ev({ t: 'server.updated', server: { name: 'Nova casa', joinMode: 'password', ownerId: ME, maxMembers: 5, hasPassword: true } }));
    expect(s.server).toMatchObject({ name: 'Nova casa', joinMode: 'password', ownerId: ME, maxMembers: 5, hasPassword: true });
  });

  it('groups members: hoisted roles strongest first, then online, then offline', () => {
    const s = run(
      start(),
      ev({ t: 'member.updated', member: member(BOB, 'Bob', { roleIds: [MOD_ROLE, ADMIN_ROLE] }) }),
      ev({ t: 'member.updated', member: member(CAROL, 'Carol', { roleIds: [ADMIN_ROLE], online: false }) }),
      ev({ t: 'member.joined', member: member('e'.repeat(32), 'ana', { roleIds: [MOD_ROLE] }) }),
    );
    const groups = groupMembers(s.members.byId, s.server.roles);
    expect(groups.map((g) => [g.key, g.members.map((m) => m.nickname)])).toEqual([
      [`role:${ADMIN_ROLE}`, ['Bob']],
      [`role:${MOD_ROLE}`, ['ana']],
      ['online', ['Dona', 'Eu']],
      ['offline', ['Carol']],
    ]);
  });

  it('roles sort strongest first with @todos last', () => {
    expect(rolesByPosition(start().server.roles).map((r) => r.id)).toEqual([ADMIN_ROLE, MOD_ROLE, FANS_ROLE, EVERYONE_ROLE]);
  });
});

describe('permissions in the UI (spec §6: only to hide buttons)', () => {
  it('a plain member has the @todos bits; the owner and admins have everything', () => {
    const s = start();
    expect(myPermissions(s)).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    const owner = run(s, ev({ t: 'server.updated', server: { name: 'Casa', joinMode: 'invite', ownerId: ME, maxMembers: 1, hasPassword: false } }));
    expect(myPermissions(owner)).toBe(ALL_PERMISSIONS);
    const admin = run(s, ev({ t: 'member.updated', member: member(ME, 'Eu', { roleIds: [ADMIN_ROLE] }) }));
    expect(myPermissions(admin)).toBe(ALL_PERMISSIONS);
  });

  it('a private channel gives nothing without an allowed role', () => {
    const s = start();
    expect(myPermissions(s, { private: true, allowedRoleIds: [MOD_ROLE] })).toBe(0);
    expect(myPermissions(s, { private: true, allowedRoleIds: [FANS_ROLE] }) & PERMISSIONS.VIEW_CHANNEL).toBeTruthy();
  });

  it('hierarchy: act only on members below my top role, never on the owner or myself', () => {
    const mod = run(start(), ev({ t: 'member.updated', member: member(ME, 'Eu', { roleIds: [MOD_ROLE] }) }));
    expect(canActOnMember(mod, BOB)).toBe(true);
    expect(canActOnMember(mod, OWNER)).toBe(false);
    expect(canActOnMember(mod, ME)).toBe(false);
    const withAdmin = run(mod, ev({ t: 'member.updated', member: member(BOB, 'Bob', { roleIds: [ADMIN_ROLE] }) }));
    expect(canActOnMember(withAdmin, BOB)).toBe(false);
    expect(manageableRoles(mod).map((r) => r.id)).toEqual([FANS_ROLE]);
  });
});

describe('parseTextEvent (spec §5.1: lenient, unknown ignored)', () => {
  it('parses known events and drops unknown keys', () => {
    const m = message(3);
    expect(parseTextEvent({ t: 'msg.new', d: { message: { ...m, spy: 1 } } })).toEqual({ t: 'msg.new', message: m });
    expect(parseTextEvent({ t: 'presence', d: { userId: BOB, online: false, x: 1 } })).toEqual({ t: 'presence', userId: BOB, online: false });
    expect(parseTextEvent({ t: 'channel.created', d: { channel: channel(SECRET, 's', 1) } })).toEqual({
      t: 'channel.created',
      channel: channel(SECRET, 's', 1),
      readState: null,
    });
  });

  it('ignores unknown types, prototype keys and malformed payloads', () => {
    for (const t of ['voice.state', 'welcome', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(parseTextEvent({ t, d: {} }), t).toBeNull();
    }
    expect(parseTextEvent({ t: 'msg.new', d: { message: { id: 'x' } } })).toBeNull();
    expect(parseTextEvent({ t: 'msg.deleted', d: { id: -1, channelId: GERAL } })).toBeNull();
    expect(parseTextEvent({ t: 'typing' })).toBeNull();
    expect(parseTextEvent({ t: 'member.left', d: { userId: BOB, reason: 'exploded' } })).toEqual({ t: 'member.left', userId: BOB, reason: 'left' });
  });
});

describe('textReducer', () => {
  it('keeps the same state object when nothing changes', () => {
    const s = start();
    expect(textReducer(s, { type: 'attention', attentive: false })).toBe(s);
    expect(textReducer(s, ev({ t: 'presence', userId: 'f'.repeat(32), online: true }))).toBe(s);
    expect(textReducer(initialText, ev({ t: 'msg.new', message: message(1) }))).toBe(initialText);
  });
});
