import { describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE_PERMISSIONS, LIMITS, PERMISSIONS, has, type Message, type ReadState } from '@ghostlink/shared';
import { silentLogger, startServer } from '../../src/index.js';
import { createTextModule } from '../../src/text/index.js';
import { withDb } from '../helpers/db.js';
import { channelId, joinServer, nextClientMsgId, textFixture, type TextClient } from './helpers.js';

async function say(c: TextClient, channel: string, content: string, extra: Record<string, unknown> = {}): Promise<Message> {
  const { message } = await c.ok<{ message: Message }>('msg.send', { channelId: channel, content, clientMsgId: nextClientMsgId(), ...extra });
  return message;
}

describe('seed and welcome (spec §5.3, §6)', () => {
  it('seeds @todos, Admin, #geral and a voice room, and sends them in the welcome', async () => {
    const { owner } = await textFixture();
    const { channels, roles, members, readStates, serverSettings } = owner.text;
    expect(channels.map((c) => [c.name, c.type])).toEqual([['geral', 'text'], ['Sala de voz', 'voice']]);
    for (const c of channels) expect(c.id).toMatch(/^[A-Z2-7]{26}$/);
    const everyone = roles.find((r) => r.isDefault)!;
    expect(everyone).toMatchObject({ name: '@todos', permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0 });
    expect(has(everyone.permissions, PERMISSIONS.CREATE_INVITES)).toBe(false);
    // Admin comes red and not hoisted, like the owner's UI reference (admins listed under "Online" with a red badge).
    expect(roles.find((r) => r.name === 'Admin')).toMatchObject({ permissions: PERMISSIONS.ADMINISTRATOR, isDefault: false, color: 0xed4245, hoist: false });
    expect(members).toEqual([expect.objectContaining({ userId: owner.userId, nickname: 'Dono', online: true, roleIds: [] })]);
    expect(readStates).toEqual([{ channelId: channelId(owner, 'geral'), lastReadMessageId: 0, mentionCount: 0 }]);
    expect(serverSettings).toEqual({ ownerId: owner.userId, maxMembers: 100, hasPassword: false });
    expect(owner.welcome.features).toContain('text');
  });

  it('seeds only once: a restart on the same data keeps the same ids', async () => {
    const f = await textFixture();
    const before = f.owner.text.channels.map((c) => c.id);
    await f.t.server.close();
    const restarted = await startServer({ dataDir: f.t.dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules: [createTextModule()] });
    try {
      const r = await joinServer(restarted, { seed: f.owner.seed, nickname: 'Dono' });
      expect(r.client?.text.channels.map((c) => c.id)).toEqual(before);
      r.client?.close();
    } finally {
      await restarted.close();
    }
    withDb(f.t.dataDir, (db) => expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM roles')?.n).toBe(2));
  });

  it('a new user joining by invite lands with #geral and is announced to the others', async () => {
    const f = await textFixture({ joinMode: 'invite' });
    const { code } = await f.owner.ok<{ code: string }>('invite.create', {});
    const ana = await f.join({ nickname: 'Ana', inviteCode: code });
    expect(ana.text.channels[0]).toMatchObject({ name: 'geral', type: 'text' });
    expect(ana.text.members.map((m) => m.nickname).sort()).toEqual(['Ana', 'Dono']);
    expect(await f.owner.event('member.joined')).toEqual({ member: expect.objectContaining({ userId: ana.userId, nickname: 'Ana', online: true }) });
    expect(await f.owner.event('presence')).toEqual({ userId: ana.userId, online: true });
    // The owner of the welcome snapshot is known to the newcomer too.
    expect(ana.text.members.find((m) => m.userId === f.owner.userId)?.online).toBe(true);
  });
});

describe('live chat between clients (spec §5.2)', () => {
  it('delivers msg.new to everyone who can see the channel, including the author', async () => {
    const f = await textFixture();
    const ana = await f.join({ nickname: 'Ana' });
    const bia = await f.join({ nickname: 'Bia' });
    const geral = channelId(ana, 'geral');
    const message = await say(ana, geral, '  oi **gente**  ');
    expect(message).toMatchObject({ channelId: geral, authorId: ana.userId, content: 'oi **gente**', editedAt: null, replyTo: null, reactions: [] });
    for (const c of [ana, bia, f.owner]) {
      expect(await c.event<{ message: Message }>('msg.new', (d) => d.message.id === message.id)).toEqual({ message });
    }
  });

  it('pages history with before/limit/hasMore, oldest first, without deleted messages', async () => {
    const f = await textFixture();
    const geral = channelId(f.owner, 'geral');
    const sent: Message[] = [];
    for (let i = 0; i < 7; i++) {
      sent.push(await say(f.owner, geral, `m${i}`));
      f.clock.now += 1_000; // refill the msg.send bucket
    }
    await f.owner.ok('msg.delete', { id: sent[6]!.id });
    const page1 = await f.owner.ok<{ messages: Message[]; hasMore: boolean }>('msg.history', { channelId: geral, limit: 3 });
    expect(page1.messages.map((m) => m.content)).toEqual(['m3', 'm4', 'm5']);
    expect(page1.hasMore).toBe(true);
    const page2 = await f.owner.ok<{ messages: Message[]; hasMore: boolean }>('msg.history', { channelId: geral, limit: 3, before: page1.messages[0]!.id });
    expect(page2.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
    expect(page2.hasMore).toBe(false);
    expect(await f.owner.fail('msg.history', { channelId: geral, limit: 51 })).toBe('BAD_REQUEST');
  });

  it('keeps every history page under the client frame cap, so long messages cannot disconnect readers', async () => {
    // The desktop client drops any frame over LIMITS.maxPayloadBytes (256 KiB) and then reloads
    // the open channel after reconnecting: an oversized page would loop forever for every reader.
    const f = await textFixture({ text: { rateLimits: { msgSendBurst: 100 } } });
    const ana = await f.join();
    const geral = channelId(ana, 'geral');
    const sent: number[] = [];
    // 4000 CJK characters are 12 000 bytes of UTF-8: 50 of them are ~600 KB.
    for (let i = 0; i < 50; i++) sent.push((await say(ana, geral, `${i}${'字'.repeat(3990)}`)).id);
    const frameBytes = (d: unknown) => Buffer.byteLength(JSON.stringify({ t: 'res', id: Number.MAX_SAFE_INTEGER, ok: true, d }), 'utf8');

    const seen: number[] = [];
    let before: number | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const page = await f.owner.ok<{ messages: Message[]; hasMore: boolean }>('msg.history', { channelId: geral, ...(before ? { before } : {}) });
      expect(frameBytes(page)).toBeLessThanOrEqual(LIMITS.maxPayloadBytes);
      expect(page.messages.length).toBeGreaterThan(0);
      const ids = page.messages.map((m) => m.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b)); // oldest first
      seen.unshift(...ids);
      before = ids[0];
      if (!page.hasMore) break;
    }
    // The pages are contiguous: every message exactly once, newest page first.
    expect(seen).toEqual(sent);
  });

  it('returns the original message for a retried clientMsgId, without a second broadcast', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(f.owner, 'geral');
    const payload = { channelId: geral, content: 'uma vez', clientMsgId: 'retry-1' };
    const first = await f.owner.ok<{ message: Message }>('msg.send', payload);
    const second = await f.owner.ok<{ message: Message }>('msg.send', payload);
    expect(second.message.id).toBe(first.message.id);
    await bia.sync();
    expect(bia.seen('msg.new')).toHaveLength(1);
  });

  it('edits: only the author, and everyone sees msg.updated', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(f.owner, 'geral');
    const m = await say(bia, geral, 'antes');
    expect(await f.owner.fail('msg.edit', { id: m.id, content: 'hack' })).toBe('FORBIDDEN');
    f.clock.now += 5_000;
    const { message } = await bia.ok<{ message: Message }>('msg.edit', { id: m.id, content: 'depois' });
    expect(message).toMatchObject({ id: m.id, content: 'depois', editedAt: f.clock.now });
    expect(await f.owner.event<{ message: Message }>('msg.updated')).toEqual({ message });
    expect(await bia.fail('msg.edit', { id: m.id, content: '   ' })).toBe('BAD_REQUEST');
    expect(await bia.fail('msg.edit', { id: 999_999, content: 'x' })).toBe('NOT_FOUND');
  });

  it('deletes: the author or MANAGE_MESSAGES; content is wiped in the database', async () => {
    const f = await textFixture();
    const ana = await f.join();
    const bia = await f.join();
    const geral = channelId(ana, 'geral');
    const m1 = await say(ana, geral, 'segredo');
    expect(await bia.fail('msg.delete', { id: m1.id })).toBe('FORBIDDEN');
    await ana.ok('msg.delete', { id: m1.id });
    expect(await bia.event('msg.deleted')).toEqual({ id: m1.id, channelId: geral });
    const row = withDb(f.t.dataDir, (db) => db.get<{ content: string; deleted_at: number | null }>('SELECT content, deleted_at FROM messages WHERE id = ?', m1.id));
    expect(row).toEqual({ content: '', deleted_at: f.clock.now });
    expect(await ana.fail('msg.delete', { id: m1.id })).toBe('NOT_FOUND');
    // The owner has every permission, MANAGE_MESSAGES included.
    const m2 = await say(bia, geral, 'spam');
    await f.owner.ok('msg.delete', { id: m2.id });
  });

  it('reactions: RGI emoji only, idempotent, at most 20 distinct, visible to all', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(bia, 'geral');
    const m = await say(f.owner, geral, 'reage');
    const { reactions } = await bia.ok<{ reactions: unknown }>('msg.react', { id: m.id, emoji: '👍' });
    expect(reactions).toEqual([{ emoji: '👍', userIds: [bia.userId] }]);
    expect(await f.owner.event('msg.reactions')).toEqual({ id: m.id, channelId: geral, reactions });
    await bia.ok('msg.react', { id: m.id, emoji: '👍' }); // no change, no event
    await f.owner.sync();
    expect(f.owner.seen('msg.reactions')).toHaveLength(1);
    expect(await bia.fail('msg.react', { id: m.id, emoji: 'lol' })).toBe('BAD_REQUEST');
    expect(await bia.fail('msg.react', { id: m.id, emoji: '<img src=x>' })).toBe('BAD_REQUEST');
    await bia.ok('msg.unreact', { id: m.id, emoji: '👍' });
    expect((await bia.ok<{ messages: Message[] }>('msg.history', { channelId: geral })).messages).toMatchObject([{ id: m.id, reactions: [] }]);

    const emoji = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗', '🤩'];
    for (let i = 0; i < 20; i++) {
      await f.owner.ok('msg.react', { id: m.id, emoji: emoji[i] });
      f.clock.now += 600; // stay under 10 per 5 s
    }
    expect(await f.owner.fail('msg.react', { id: m.id, emoji: emoji[20] })).toBe('BAD_REQUEST');
    await bia.ok('msg.react', { id: m.id, emoji: emoji[0] }); // an existing emoji is still fine
  });

  it('typing reaches the other viewers but not the sender', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(bia, 'geral');
    await bia.ok('typing', { channelId: geral });
    expect(await f.owner.event('typing')).toEqual({ channelId: geral, userId: bia.userId });
    await bia.sync();
    expect(bia.seen('typing')).toEqual([]);
  });

  it('replies quote a message of the same channel', async () => {
    const f = await textFixture();
    const geral = channelId(f.owner, 'geral');
    const original = await say(f.owner, geral, 'pergunta');
    const reply = await say(f.owner, geral, 'resposta', { replyTo: original.id });
    expect(reply.replyTo).toEqual({ id: original.id, authorId: f.owner.userId, content: 'pergunta', deleted: false });
    expect(await f.owner.fail('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId(), replyTo: 424242 })).toBe('NOT_FOUND');
  });

  it('refuses attachments (v0.1) with BAD_ATTACHMENT and chat in voice channels with BAD_REQUEST', async () => {
    const f = await textFixture();
    const geral = channelId(f.owner, 'geral');
    const voice = channelId(f.owner, 'Sala de voz');
    expect(await f.owner.fail('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId(), attachmentIds: ['AAAA'] })).toBe('BAD_ATTACHMENT');
    await f.owner.ok('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId(), attachmentIds: [] });
    expect(await f.owner.fail('msg.send', { channelId: voice, content: 'x', clientMsgId: nextClientMsgId() })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('msg.history', { channelId: voice })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('typing', { channelId: voice })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('channel.read', { channelId: voice, messageId: 0 })).toBe('BAD_REQUEST');
  });
});

describe('unread and mentions (spec §7)', () => {
  it('tracks unread through lastMessageId > lastReadMessageId, and channel.read moves forward only', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(bia, 'geral');
    const m1 = await say(f.owner, geral, 'um');
    f.clock.now += 1_000;
    const m2 = await say(f.owner, geral, 'dois');
    const { readState } = await bia.ok<{ readState: ReadState }>('channel.read', { channelId: geral, messageId: m1.id });
    expect(readState).toEqual({ channelId: geral, lastReadMessageId: m1.id, mentionCount: 0 });
    // Backwards is ignored; beyond the newest message is clamped.
    expect((await bia.ok<{ readState: ReadState }>('channel.read', { channelId: geral, messageId: 0 })).readState.lastReadMessageId).toBe(m1.id);
    expect((await bia.ok<{ readState: ReadState }>('channel.read', { channelId: geral, messageId: 10 ** 12 })).readState.lastReadMessageId).toBe(m2.id);
    // The author's own message counts as read.
    const again = await f.join({ seed: f.owner.seed, nickname: 'Dono' });
    expect(again.text.readStates[0]!.lastReadMessageId).toBe(m2.id);
    expect(again.text.channels[0]!.lastMessageId).toBe(m2.id);
  });

  it('counts mentions of a user, of mentionable roles and of @everyone only with MENTION_EVERYONE', async () => {
    const f = await textFixture();
    const ana = await f.join();
    const bia = await f.join();
    const geral = channelId(ana, 'geral');
    const { role } = await f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Galera', mentionable: true });
    const { role: quiet } = await f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Quietos', mentionable: false });
    await f.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id, quiet.id] });

    const direct = await say(ana, geral, `oi <@${bia.userId}> e <@${ana.userId}>`);
    expect(direct.mentions).toEqual({ users: [bia.userId, ana.userId], roles: [], everyone: false });
    f.clock.now += 1_000;
    const everyone = await say(ana, geral, '@everyone acordem');
    expect(everyone.mentions.everyone).toBe(false); // @todos has no MENTION_EVERYONE
    f.clock.now += 1_000;
    const roles = await say(ana, geral, `<@&${role.id}> <@&${quiet.id}>`);
    expect(roles.mentions.roles).toEqual([role.id]); // not mentionable → plain text
    f.clock.now += 1_000;
    await say(f.owner, geral, '@everyone reunião'); // the owner has MENTION_EVERYONE
    await say(f.owner, geral, `\`<@${bia.userId}>\``); // code does not ping

    bia.close();
    const back = await f.join({ seed: bia.seed, nickname: bia.nickname });
    expect(back.text.readStates.find((r) => r.channelId === geral)?.mentionCount).toBe(3);
    const anaBack = ana;
    anaBack.close();
    const ana2 = await f.join({ seed: ana.seed, nickname: ana.nickname });
    // Ana mentioned herself (never counted) and got @everyone from the owner.
    expect(ana2.text.readStates.find((r) => r.channelId === geral)?.mentionCount).toBe(1);
    // Reading clears the count.
    await ana2.ok('channel.read', { channelId: geral, messageId: 10 ** 12 });
    const ana3 = await f.join({ seed: ana.seed, nickname: ana.nickname });
    expect(ana3.text.readStates.find((r) => r.channelId === geral)?.mentionCount).toBe(0);
  });
});

describe('profile.update (nickname only)', () => {
  it('renames, announces member.updated, refuses a taken nickname', async () => {
    const f = await textFixture();
    const bia = await f.join({ nickname: 'Bia' });
    const { member } = await bia.ok<{ member: { nickname: string } }>('profile.update', { nickname: '  Bia​ Nova ' });
    expect(member.nickname).toBe('Bia Nova');
    expect(await f.owner.event('member.updated')).toEqual({ member });
    expect(await bia.fail('profile.update', { nickname: 'dono' })).toBe('NICK_TAKEN');
    expect(await bia.fail('profile.update', { nickname: '‮' })).toBe('BAD_REQUEST');
    expect(await bia.fail('profile.update', { avatarFileId: null })).toBe('BAD_REQUEST');
  });
});

