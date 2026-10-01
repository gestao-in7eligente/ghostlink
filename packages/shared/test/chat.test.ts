import { describe, expect, it } from 'vitest';
import {
  CHAT_LIMITS,
  EVERYONE_MENTION,
  channelCreateSchema,
  channelSchemaClient,
  channelUpdateSchema,
  cleanMessageContent,
  extractMentions,
  isReactionEmoji,
  inviteLinksSchemaClient,
  memberSchemaClient,
  messageSchemaClient,
  msgHistorySchema,
  msgReactSchema,
  msgSendSchema,
  profileUpdateSchema,
  reactionSchemaClient,
  serverInfoSchemaClient,
  serverUpdateSchema,
  stripCode,
  textWelcomeSchemaClient,
} from '../src/index.js';

const USER = 'a'.repeat(32);
const USER2 = 'b'.repeat(32);
const ROLE = 'A'.repeat(26);

describe('isReactionEmoji (spec §5.2: ^\\p{RGI_Emoji}$ with the v flag)', () => {
  it.each(['👍', '👍🏽', '❤️', '👨‍👩‍👧', '🇧🇷', '#️⃣'])('accepts %s', (e) => {
    expect(isReactionEmoji(e)).toBe(true);
  });

  it.each(['a', '1', '👍👍', ' 👍', '👍 ', '', '<b>', ':smile:', '❤'.repeat(40), '‮👍'])('refuses %j', (e) => {
    expect(isReactionEmoji(e)).toBe(false);
  });

  it('refuses non-strings and very long input without scanning it', () => {
    expect(isReactionEmoji(42)).toBe(false);
    expect(isReactionEmoji('👍'.repeat(10_000))).toBe(false);
  });
});

describe('stripCode', () => {
  it('removes inline code and fenced blocks, keeps the rest', () => {
    expect(stripCode('a `<@x>` b ```\n@everyone\n``` c')).toBe('a   b   c');
  });

  it('treats an unclosed fence or backtick as plain text', () => {
    expect(stripCode('```\n@everyone')).toBe('```\n@everyone');
    expect(stripCode('a ` b')).toBe('a ` b');
  });

  it('stays linear on pathological input', () => {
    const evil = '`'.repeat(50_000) + 'x'.repeat(50_000) + '```'.repeat(20_000);
    const started = performance.now();
    stripCode(evil);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('extractMentions', () => {
  it('finds user and role tokens and @everyone, deduplicated', () => {
    expect(extractMentions(`hi <@${USER}> and <@${USER}> <@&${ROLE}> @everyone`)).toEqual({
      users: [USER],
      roles: [ROLE],
      everyone: true,
    });
  });

  it('ignores mentions inside code and malformed tokens', () => {
    expect(extractMentions(`\`<@${USER}>\` \`\`\`\n@everyone\n\`\`\` <@${USER.slice(1)}> <@&abc> email@everyone.com`)).toEqual({
      users: [],
      roles: [],
      everyone: false,
    });
  });

  it('caps how many distinct ids are considered', () => {
    const many = Array.from({ length: 200 }, (_, i) => `<@${i.toString(16).padStart(32, '0')}>`).join(' ');
    expect(extractMentions(many).users).toHaveLength(CHAT_LIMITS.maxMentionsPerMessage);
  });

  it('uses the canonical @everyone token', () => {
    expect(EVERYONE_MENTION).toBe('@everyone');
    expect(extractMentions('@everyone!').everyone).toBe(true);
    expect(extractMentions('@everyoneX').everyone).toBe(false);
  });
});

describe('cleanMessageContent', () => {
  it('normalizes newlines and drops control characters and lone surrogates', () => {
    expect(cleanMessageContent('a\r\nb\u0000c\u0007\td\ud800')).toBe('a\nbc\td');
  });

  it('trims surrounding blank lines and spaces', () => {
    expect(cleanMessageContent('  \n hi \n ')).toBe('hi');
  });
});

describe('server request schemas (strict)', () => {
  it('msg.send: content bounds, clientMsgId, optional reply and attachments', () => {
    const ok = { channelId: ROLE, content: 'oi', clientMsgId: 'c-1' };
    expect(msgSendSchema.safeParse(ok).success).toBe(true);
    expect(msgSendSchema.safeParse({ ...ok, replyTo: 12, attachmentIds: [] }).success).toBe(true);
    expect(msgSendSchema.safeParse({ ...ok, content: 'x'.repeat(4001) }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, content: 'x'.repeat(4000) }).success).toBe(true);
    expect(msgSendSchema.safeParse({ ...ok, clientMsgId: 'a b' }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, replyTo: -1 }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, replyTo: 1.5 }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, attachmentIds: Array(11).fill(ROLE) }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, content: '', attachmentIds: Array(10).fill(ROLE) }).success).toBe(true);
    expect(msgSendSchema.safeParse({ ...ok, attachmentIds: ['../x'] }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(msgSendSchema.safeParse({ ...ok, channelId: '../x' }).success).toBe(false);
  });

  it('msg.history: limit at most 50', () => {
    expect(msgHistorySchema.safeParse({ channelId: ROLE }).success).toBe(true);
    expect(msgHistorySchema.safeParse({ channelId: ROLE, before: 10, limit: 50 }).success).toBe(true);
    expect(msgHistorySchema.safeParse({ channelId: ROLE, limit: 51 }).success).toBe(false);
    expect(msgHistorySchema.safeParse({ channelId: ROLE, limit: 0 }).success).toBe(false);
  });

  it('msg.react: emoji must be one RGI emoji', () => {
    expect(msgReactSchema.safeParse({ id: 1, emoji: '👍' }).success).toBe(true);
    expect(msgReactSchema.safeParse({ id: 1, emoji: 'x' }).success).toBe(false);
  });

  it('channel.create / update', () => {
    expect(channelCreateSchema.safeParse({ name: 'geral', type: 'text' }).success).toBe(true);
    expect(channelCreateSchema.safeParse({ name: 'sala', type: 'voice', userLimit: 10, private: true, allowedRoleIds: [ROLE] }).success).toBe(true);
    expect(channelCreateSchema.safeParse({ name: 'x', type: 'video' }).success).toBe(false);
    expect(channelCreateSchema.safeParse({ name: 'x'.repeat(101), type: 'text' }).success).toBe(false);
    expect(channelCreateSchema.safeParse({ name: 'x', type: 'text', userLimit: 100 }).success).toBe(false);
    expect(channelUpdateSchema.safeParse({ id: ROLE }).success).toBe(true);
    expect(channelUpdateSchema.safeParse({ id: ROLE, type: 'voice' }).success).toBe(false);
  });

  it('profile.update: nickname only in v0.1', () => {
    expect(profileUpdateSchema.safeParse({ nickname: 'Ana' }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ avatarFileId: null }).success).toBe(false);
  });

  it('server.update: the upload limit and the quota within bounds; the icon goes through upload.begin', () => {
    expect(serverUpdateSchema.safeParse({ name: 'Casa', joinMode: 'password', password: 'x', maxMembers: 10 }).success).toBe(true);
    expect(serverUpdateSchema.safeParse({ password: null }).success).toBe(true);
    expect(serverUpdateSchema.safeParse({ iconFileId: ROLE }).success).toBe(false);
    expect(serverUpdateSchema.safeParse({ maxMembers: 0 }).success).toBe(false);
    expect(serverUpdateSchema.safeParse({ joinMode: 'secret' }).success).toBe(false);
    expect(serverUpdateSchema.safeParse({ uploadLimitMb: 100, storageQuotaMb: 50_000 }).success).toBe(true);
    for (const bad of [{ uploadLimitMb: 0 }, { uploadLimitMb: 2049 }, { uploadLimitMb: 1.5 }, { storageQuotaMb: 0 }, { storageQuotaMb: 1_048_577 }]) {
      expect(serverUpdateSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('client schemas (lenient)', () => {
  const message = {
    id: 5,
    channelId: ROLE,
    authorId: USER,
    content: 'oi',
    createdAt: 1,
    editedAt: null,
    replyTo: null,
    reactions: [{ emoji: '👍', userIds: [USER2] }],
    mentions: { users: [], roles: [], everyone: false },
    clientMsgId: 'c1',
    attachments: [
      { id: ROLE, name: 'foto.png', size: 1234, kind: 'image', mime: 'image/png', width: 640, height: 480 },
      { id: 'B'.repeat(26), name: 'nota.pdf', size: 99, kind: 'file', mime: 'application/pdf' },
    ],
  };

  it('keeps known fields and drops unknown ones', () => {
    const parsed = messageSchemaClient.parse({ ...message, surprise: 1 });
    expect(parsed).toEqual(message);
  });

  it('reads a message from a server without attachments, or with odd ones, safely', () => {
    const { attachments: _, ...old } = message;
    expect(messageSchemaClient.parse(old).attachments).toEqual([]);
    const odd = messageSchemaClient.parse({ ...message, attachments: [{ id: ROLE, name: 'x', size: 1, kind: 'virus', mime: 7, width: -1 }] });
    expect(odd.attachments).toEqual([{ id: ROLE, name: 'x', size: 1, kind: 'file', mime: 'application/octet-stream', width: undefined, height: undefined }]);
  });

  it('parses a channel and a member', () => {
    const channel = { id: ROLE, name: 'geral', type: 'text', topic: '', position: 0, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0 };
    expect(channelSchemaClient.parse(channel)).toEqual(channel);
    const member = { userId: USER, nickname: 'Ana', roleIds: [], online: true, joinedAt: 1, avatar: 'a'.repeat(64) };
    expect(memberSchemaClient.parse(member)).toEqual(member);
  });

  it('reads a member without a photo, or with a broken one, as initials', () => {
    const member = { userId: USER, nickname: 'Ana', roleIds: [], online: true, joinedAt: 1 };
    // A server before 0.2.2 sends no avatar key.
    expect(memberSchemaClient.parse(member)).toEqual({ ...member, avatar: null });
    expect(memberSchemaClient.parse({ ...member, avatar: '../etc/passwd' })).toEqual({ ...member, avatar: null });
    expect(memberSchemaClient.parse({ ...member, avatar: 'A'.repeat(64) })).toEqual({ ...member, avatar: null });
  });

  it('parses the text part of a welcome, defaulting missing lists', () => {
    const parsed = textWelcomeSchemaClient.parse({});
    expect(parsed).toEqual({
      channels: [],
      roles: [],
      members: [],
      readStates: [],
      serverSettings: { ownerId: null, maxMembers: 0, hasPassword: false, uploadLimitMb: 25, storageQuotaMb: 10_240, icon: null },
    });
  });

  it('parses reactions, dropping unknown keys', () => {
    expect(reactionSchemaClient.parse({ emoji: '👍', userIds: [USER], extra: true })).toEqual({ emoji: '👍', userIds: [USER] });
    expect(reactionSchemaClient.safeParse({ emoji: '👍' }).success).toBe(false);
  });

  it('parses the server.updated payload (and the server.update answer)', () => {
    const info = {
      name: 'Casa',
      joinMode: 'invite',
      ownerId: USER,
      maxMembers: 100,
      hasPassword: false,
      uploadLimitMb: 50,
      storageQuotaMb: 2048,
      icon: 'c'.repeat(64),
    };
    expect(serverInfoSchemaClient.parse({ ...info, secret: 'x' })).toEqual(info);
    // A server before attachments sends no limits: its database defaults.
    const { uploadLimitMb: _u, storageQuotaMb: _q, ...noLimits } = info;
    expect(serverInfoSchemaClient.parse(noLimits)).toEqual({ ...noLimits, uploadLimitMb: 25, storageQuotaMb: 10_240 });
    expect(serverInfoSchemaClient.safeParse({ ...info, joinMode: 'secret' }).success).toBe(false);
    // A server before 0.3.2 sends no icon, and a malformed one is no icon: initials.
    const { icon: _icon, ...old } = info;
    expect(serverInfoSchemaClient.parse(old)).toEqual({ ...old, icon: null });
    expect(serverInfoSchemaClient.parse({ ...info, icon: '../x' })).toEqual({ ...old, icon: null });
  });

  it('parses the invite.create answer', () => {
    const invite = { code: 'ABCDEFGHIJ', link: 'ghostlink://join?x', pasteCode: 'GL1-x', webLink: 'https://example.test/j/#x' };
    expect(inviteLinksSchemaClient.parse(invite)).toEqual(invite);
    expect(inviteLinksSchemaClient.safeParse({ ...invite, webLink: 'x'.repeat(5000) }).success).toBe(false);
  });
});
