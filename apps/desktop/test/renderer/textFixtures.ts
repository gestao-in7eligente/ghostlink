// Builders for the text-store tests: a server snapshot as a welcome would carry it.
import { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS, type Channel, type Member, type Message, type Role } from '@ghostlink/shared';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';
import type { TextEvent, TextSnapshot } from '../../src/renderer/features/chat/events.js';
import { textReducer, initialText, type TextAction, type TextState } from '../../src/renderer/stores/text.js';

export const ME = 'a'.repeat(32);
export const BOB = 'b'.repeat(32);
export const CAROL = 'c'.repeat(32);
export const OWNER = 'd'.repeat(32);

export const GERAL = 'G'.repeat(26);
export const RANDOM = 'R'.repeat(26);
export const SECRET = 'S'.repeat(26);
export const VOICE = 'V'.repeat(26);

export const EVERYONE_ROLE = 'E'.repeat(26);
export const ADMIN_ROLE = 'A'.repeat(26);
export const MOD_ROLE = 'M'.repeat(26);
export const FANS_ROLE = 'F'.repeat(26);

export function role(id: string, name: string, position: number, extra: Partial<Role> = {}): Role {
  return { id, name, color: 0, permissions: 0, position, hoist: false, mentionable: false, isDefault: false, ...extra };
}

export const ROLES: Role[] = [
  role(EVERYONE_ROLE, '@todos', 0, { permissions: DEFAULT_EVERYONE_PERMISSIONS, isDefault: true }),
  role(ADMIN_ROLE, 'Admin', 3, { permissions: PERMISSIONS.ADMINISTRATOR, hoist: true, color: 0xed4245 }),
  role(MOD_ROLE, 'Mods', 2, { permissions: PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_ROLES, hoist: true }),
  role(FANS_ROLE, 'Fãs', 1, { mentionable: true }),
];

export function channel(id: string, name: string, position: number, extra: Partial<Channel> = {}): Channel {
  return { id, name, type: 'text', topic: '', position, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0, ...extra };
}

export function member(userId: string, nickname: string, extra: Partial<Member> = {}): Member {
  return { userId, nickname, roleIds: [], online: true, joinedAt: 1, ...extra };
}

let nextClient = 0;
export function message(id: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId: GERAL,
    authorId: BOB,
    content: `mensagem ${id}`,
    createdAt: 1_700_000_000_000 + id * 1000,
    editedAt: null,
    replyTo: null,
    reactions: [],
    mentions: { users: [], roles: [], everyone: false },
    clientMsgId: `c${++nextClient}`,
    ...extra,
  };
}

export function snapshot(extra: Partial<TextSnapshot['text']> = {}, serverId = 'srv-1'): TextSnapshot {
  return {
    serverId,
    self: { userId: ME, nickname: 'Eu', isOwner: false },
    server: { name: 'Casa', joinMode: 'invite', version: '0.1.0' },
    text: {
      channels: [
        channel(RANDOM, 'random', 1, { lastMessageId: 7 }),
        channel(GERAL, 'geral', 0, { lastMessageId: 10 }),
        channel(VOICE, 'Sala de voz', 2, { type: 'voice' }),
      ],
      roles: ROLES,
      members: [member(ME, 'Eu', { roleIds: [FANS_ROLE] }), member(BOB, 'Bob'), member(CAROL, 'Carol', { online: false }), member(OWNER, 'Dona')],
      readStates: [
        { channelId: GERAL, lastReadMessageId: 10, mentionCount: 0 },
        { channelId: RANDOM, lastReadMessageId: 3, mentionCount: 1 },
      ],
      serverSettings: { ownerId: OWNER, maxMembers: 100, hasPassword: false },
      ...extra,
    },
  };
}

/** A renderer welcome with the text module keys riding along. */
export function welcomeWithText(snap = snapshot()): RendererWelcome {
  return {
    serverId: snap.serverId,
    self: snap.self,
    sessionId: 'sess',
    serverTime: 1,
    server: { ...snap.server, serverKeyId: 'k'.repeat(43) },
    features: ['text'],
    protocol: { min: 1, max: 1 },
    ...snap.text,
  } as RendererWelcome;
}

export function run(state: TextState, ...actions: TextAction[]): TextState {
  return actions.reduce(textReducer, state);
}

export function start(snap = snapshot()): TextState {
  return run(initialText, { type: 'reset', snapshot: snap });
}

export const NOW = 1_700_000_100_000;

export function ev(event: TextEvent, now = NOW): TextAction {
  return { type: 'event', event, now };
}

/** A state with #geral loaded (messages 8, 9, 10). */
export function loaded(state = start()): TextState {
  return run(
    state,
    { type: 'history.start', channelId: GERAL, older: false },
    { type: 'history.done', channelId: GERAL, older: false, messages: [message(8), message(9), message(10)], hasMore: true },
  );
}
