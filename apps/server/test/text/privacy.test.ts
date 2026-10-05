import { describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS, type Channel, type Message } from '@ghostlink/shared';
import { withDb } from '../helpers/db.js';
import { channelId, nextClientMsgId, roleId, textFixture, type TextClient, type TextFixture } from './helpers.js';

const MISSING_CHANNEL = 'A'.repeat(26);

interface Scene {
  f: TextFixture;
  staffRole: string;
  staff: string; // the private channel
  geral: string;
  mod: TextClient; // has the Staff role
  member: TextClient; // plain member
  admin: TextClient; // Admin role (ADMINISTRATOR), not listed on the channel
}

/** Owner + a private #staff channel for the Staff role (spec §6: private channels). */
async function scene(): Promise<Scene> {
  const f = await textFixture();
  const mod = await f.join({ nickname: 'Mod' });
  const member = await f.join({ nickname: 'Membro' });
  const admin = await f.join({ nickname: 'Adm' });
  const { role } = await f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Staff' });
  await f.owner.ok('member.setRoles', { userId: mod.userId, roleIds: [role.id] });
  await f.owner.ok('member.setRoles', { userId: admin.userId, roleIds: [roleId(f.owner, 'Admin')] });
  const { channel } = await f.owner.ok<{ channel: Channel }>('channel.create', { name: 'staff', type: 'text', private: true, allowedRoleIds: [role.id] });
  for (const c of [mod, member, admin]) await c.sync();
  return { f, staffRole: role.id, staff: channel.id, geral: channelId(f.owner, 'geral'), mod, member, admin };
}

async function say(c: TextClient, channel: string, content: string, extra: Record<string, unknown> = {}): Promise<Message> {
  return (await c.ok<{ message: Message }>('msg.send', { channelId: channel, content, clientMsgId: nextClientMsgId(), ...extra })).message;
}

/** Nothing about `channelId` ever reached `c` (checks every event received so far). */
function noTraceOf(c: TextClient, channelId: string, secret?: string): void {
  const dump = JSON.stringify(c.events);
  expect(dump).not.toContain(channelId);
  if (secret) expect(dump).not.toContain(secret);
}

describe('private channels never leak (spec §5.3, §6)', () => {
  it('announces a new private channel only to those who may see it', async () => {
    const s = await scene();
    expect(await s.mod.event<{ channel: Channel }>('channel.created', (d) => d.channel.id === s.staff)).toMatchObject({ channel: { name: 'staff', private: true } });
    expect(await s.admin.event<{ channel: Channel }>('channel.created', (d) => d.channel.id === s.staff)).toBeTruthy();
    await s.member.sync();
    noTraceOf(s.member, s.staff);
  });

  it('keeps it out of the welcome snapshot of members without an allowed role', async () => {
    const s = await scene();
    const fresh = await s.f.join({ seed: s.member.seed, nickname: s.member.nickname });
    expect(fresh.text.channels.map((c) => c.id)).not.toContain(s.staff);
    expect(fresh.text.readStates.map((r) => r.channelId)).not.toContain(s.staff);
    const modAgain = await s.f.join({ seed: s.mod.seed, nickname: s.mod.nickname });
    expect(modAgain.text.channels.map((c) => c.id)).toContain(s.staff);
  });

  it('delivers messages, edits, reactions, typing and deletions only to viewers', async () => {
    const s = await scene();
    s.member.clear();
    const m = await say(s.mod, s.staff, 'plano secreto');
    await s.mod.ok('msg.react', { id: m.id, emoji: '🤫' });
    await s.mod.ok('msg.edit', { id: m.id, content: 'plano secreto v2' });
    await s.admin.ok('typing', { channelId: s.staff });
    await s.f.owner.ok('channel.read', { channelId: s.staff, messageId: m.id });
    await s.mod.ok('msg.delete', { id: m.id });
    expect(await s.admin.event('msg.new')).toBeTruthy();
    expect(await s.mod.event('typing')).toEqual({ channelId: s.staff, userId: s.admin.userId });
    await s.member.sync();
    noTraceOf(s.member, s.staff, 'secreto');
    expect(s.member.seen('msg.new')).toEqual([]);
    expect(s.member.seen('msg.deleted')).toEqual([]);
  });

  it('answers NOT_FOUND to every request about it, exactly like a missing channel', async () => {
    const s = await scene();
    const m = await say(s.mod, s.staff, 'x');
    const probes: Array<[string, (ch: string) => unknown]> = [
      ['msg.history', (ch) => ({ channelId: ch })],
      ['msg.send', (ch) => ({ channelId: ch, content: 'x', clientMsgId: nextClientMsgId() })],
      ['typing', (ch) => ({ channelId: ch })],
      ['channel.read', (ch) => ({ channelId: ch, messageId: 1 })],
    ];
    for (const [type, payload] of probes) {
      expect(await s.member.fail(type, payload(s.staff)), type).toBe('NOT_FOUND');
      expect(await s.member.fail(type, payload(MISSING_CHANNEL)), type).toBe('NOT_FOUND');
    }
    for (const type of ['msg.edit', 'msg.delete', 'msg.react', 'msg.unreact']) {
      const d = type === 'msg.edit' ? { id: m.id, content: 'y' } : type === 'msg.delete' ? { id: m.id } : { id: m.id, emoji: '👍' };
      expect(await s.member.fail(type, d), type).toBe('NOT_FOUND');
    }
    // A reply cannot quote a message from a channel you cannot see, nor from another channel at all.
    expect(await s.member.fail('msg.send', { channelId: s.geral, content: 'x', clientMsgId: nextClientMsgId(), replyTo: m.id })).toBe('NOT_FOUND');
    expect(await s.mod.fail('msg.send', { channelId: s.geral, content: 'x', clientMsgId: nextClientMsgId(), replyTo: m.id })).toBe('NOT_FOUND');
  });

  it('hides it from someone with MANAGE_CHANNELS who is not on the list', async () => {
    const s = await scene();
    const { role } = await s.f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Canais', permissions: PERMISSIONS.MANAGE_CHANNELS });
    await s.f.owner.ok('member.setRoles', { userId: s.member.userId, roleIds: [role.id] });
    expect(await s.member.fail('channel.update', { id: s.staff, name: 'aberto' })).toBe('NOT_FOUND');
    expect(await s.member.fail('channel.delete', { id: s.staff })).toBe('NOT_FOUND');
    expect(await s.member.fail('channel.update', { id: MISSING_CHANNEL, name: 'aberto' })).toBe('NOT_FOUND');
    // Reorder must list exactly the visible channels; hidden ones keep their place.
    const visible = [s.geral, channelId(s.f.owner, 'Sala de voz')];
    expect(await s.member.fail('channel.reorder', { ids: [...visible, s.staff] })).toBe('BAD_REQUEST');
    await s.member.ok('channel.reorder', { ids: [...visible].reverse() });
    const positions = withDb(s.f.t.dataDir, (db) => db.all<{ id: string; position: number }>('SELECT id, position FROM channels ORDER BY position'));
    expect(positions.map((p) => p.id)).toEqual([...visible.reverse(), s.staff]);
  });

  it('never creates mentions for people who cannot see the channel', async () => {
    const s = await scene();
    const m = await say(s.f.owner, s.staff, `<@${s.member.userId}> <@${s.mod.userId}> @everyone`);
    const rows = withDb(s.f.t.dataDir, (db) => db.all<{ user_id: string }>('SELECT user_id FROM mentions WHERE message_id = ?', m.id)).map((r) => r.user_id).sort();
    expect(rows).toEqual([s.mod.userId, s.admin.userId].sort());
  });

  it('sends channel.created (with the read state) when a role grants access, and channel.deleted when it goes', async () => {
    const s = await scene();
    const m = await say(s.mod, s.staff, 'antes de você chegar');
    s.member.clear();
    await s.f.owner.ok('member.setRoles', { userId: s.member.userId, roleIds: [s.staffRole] });
    const gained = await s.member.event<{ channel: Channel; readState: unknown }>('channel.created');
    expect(gained).toEqual({
      channel: expect.objectContaining({ id: s.staff, lastMessageId: m.id }),
      readState: { channelId: s.staff, lastReadMessageId: 0, mentionCount: 0 },
    });
    expect((await s.member.ok<{ messages: Message[] }>('msg.history', { channelId: s.staff })).messages).toHaveLength(1);

    await s.f.owner.ok('member.setRoles', { userId: s.member.userId, roleIds: [] });
    expect(await s.member.event('channel.deleted')).toEqual({ id: s.staff });
    expect(await s.member.fail('msg.history', { channelId: s.staff })).toBe('NOT_FOUND');
  });

  it('checks VIEW_CHANNEL at the moment of the action, even for the author (spec §5.3)', async () => {
    const s = await scene();
    const mine = await say(s.mod, s.staff, 'meu');
    await s.f.owner.ok('member.setRoles', { userId: s.mod.userId, roleIds: [] });
    await s.mod.event('channel.deleted');
    expect(await s.mod.fail('msg.edit', { id: mine.id, content: 'editado' })).toBe('NOT_FOUND');
    expect(await s.mod.fail('msg.delete', { id: mine.id })).toBe('NOT_FOUND');
    expect(await s.mod.fail('msg.react', { id: mine.id, emoji: '👍' })).toBe('NOT_FOUND');
  });

  it('turns visibility on and off with channel.update (private flag and allowed roles)', async () => {
    const s = await scene();
    s.member.clear();
    await s.f.owner.ok('channel.update', { id: s.geral, private: true, allowedRoleIds: [s.staffRole] });
    expect(await s.member.event('channel.deleted')).toEqual({ id: s.geral });
    expect(await s.mod.event<{ channel: Channel }>('channel.updated', (d) => d.channel.id === s.geral)).toMatchObject({ channel: { private: true } });
    await s.f.owner.ok('channel.update', { id: s.geral, private: false });
    expect(await s.member.event<{ channel: Channel }>('channel.created')).toMatchObject({ channel: { id: s.geral, private: false } });
    expect(await s.f.owner.fail('channel.update', { id: s.geral, private: true, allowedRoleIds: [roleId(s.f.owner, '@todos')] })).toBe('BAD_REQUEST');
  });

  it('removing VIEW_CHANNEL from @todos hides every channel except from admins', async () => {
    const s = await scene();
    const everyone = roleId(s.f.owner, '@todos');
    await s.f.owner.ok('role.update', { id: everyone, permissions: DEFAULT_EVERYONE_PERMISSIONS & ~PERMISSIONS.VIEW_CHANNEL });
    const lost = new Set<string>();
    await s.member.event('channel.deleted', (d: { id: string }) => {
      lost.add(d.id);
      return lost.size === 2;
    });
    await s.admin.sync();
    expect(s.admin.seen('channel.deleted')).toEqual([]);
    expect(await s.member.fail('msg.history', { channelId: s.geral })).toBe('NOT_FOUND');
  });

  it('deleting a channel tells only its viewers', async () => {
    const s = await scene();
    s.member.clear();
    await s.f.owner.ok('channel.delete', { id: s.staff });
    expect(await s.mod.event('channel.deleted')).toEqual({ id: s.staff });
    await s.member.sync();
    noTraceOf(s.member, s.staff);
    withDb(s.f.t.dataDir, (db) => expect(db.get('SELECT 1 AS x FROM messages WHERE channel_id = ?', s.staff)).toBeUndefined());
  });

  it('VoiceAccess reports 0 for a hidden channel and the real bits for a viewer', async () => {
    const s = await scene();
    const access = s.f.text.voiceAccess;
    expect(access.permissions(s.member.userId, s.staff)).toBe(0);
    expect(access.permissions(s.mod.userId, s.staff) & PERMISSIONS.VIEW_CHANNEL).toBeTruthy();
    expect(access.permissions(s.member.userId, MISSING_CHANNEL)).toBe(0);
    expect(access.channel(s.staff)).toEqual({ type: 'text', userLimit: 0 });
    expect(access.channel(MISSING_CHANNEL)).toBeNull();
  });
});
