import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Message, type Role } from '@ghostlink/shared';
import { getUser, withDb } from '../helpers/db.js';
import { channelId, nextClientMsgId, roleId, textFixture, type TextClient, type TextFixture } from './helpers.js';

async function makeRole(f: TextFixture, name: string, permissions = 0, extra: Record<string, unknown> = {}): Promise<Role> {
  return (await f.owner.ok<{ role: Role }>('role.create', { name, permissions, ...extra })).role;
}

async function give(f: TextFixture, c: TextClient, ...roles: Role[]): Promise<void> {
  await f.owner.ok('member.setRoles', { userId: c.userId, roleIds: roles.map((r) => r.id) });
}

describe('roles and hierarchy (spec §6)', () => {
  it('creates roles at the bottom, and only with bits the creator has', async () => {
    const f = await textFixture();
    const mgr = await f.join();
    const managers = await makeRole(f, 'Gerentes', PERMISSIONS.MANAGE_ROLES);
    await give(f, mgr, managers);
    const { role } = await mgr.ok<{ role: Role }>('role.create', { name: '  Novatos  ', color: 0x5865f2, hoist: true });
    expect(role).toMatchObject({ name: 'Novatos', position: 1, color: 0x5865f2, hoist: true, isDefault: false });
    expect(await f.owner.event<{ role: Role }>('role.created', (d) => d.role.id === role.id)).toEqual({ role });
    // Everyone above moved up by one; the manager still outranks the new role.
    const again = await f.join({ seed: mgr.seed, nickname: mgr.nickname });
    expect(again.text.roles.find((r) => r.id === managers.id)!.position).toBeGreaterThan(1);
    expect(await again.fail('role.create', { name: 'Poder', permissions: PERMISSIONS.BAN_MEMBERS })).toBe('FORBIDDEN');
    expect(await again.fail('role.create', { name: 'Poder', permissions: PERMISSIONS.ADMINISTRATOR })).toBe('FORBIDDEN');
    expect(await again.fail('role.create', { name: '​' })).toBe('BAD_REQUEST');
  });

  it('manages only roles below the actor top role', async () => {
    const f = await textFixture();
    const mgr = await f.join();
    const low = await makeRole(f, 'Baixo');
    const managers = await makeRole(f, 'Gerentes', PERMISSIONS.MANAGE_ROLES | PERMISSIONS.KICK_MEMBERS);
    const high = await makeRole(f, 'Alto');
    await f.owner.ok('role.reorder', { ids: [high.id, managers.id, low.id] });
    await give(f, mgr, managers);
    expect(await mgr.fail('role.update', { id: high.id, name: 'x' })).toBe('HIERARCHY');
    expect(await mgr.fail('role.update', { id: managers.id, permissions: PERMISSIONS.MANAGE_ROLES })).toBe('HIERARCHY'); // its own top role
    expect(await mgr.fail('role.delete', { id: high.id })).toBe('HIERARCHY');
    expect(await mgr.fail('role.reorder', { ids: [high.id, low.id] })).toBe('HIERARCHY');
    await mgr.ok('role.update', { id: low.id, name: 'Baixinho', permissions: PERMISSIONS.KICK_MEMBERS });
    // Granting a bit the actor lacks is refused even on a role they manage.
    expect(await mgr.fail('role.update', { id: low.id, permissions: PERMISSIONS.BAN_MEMBERS })).toBe('FORBIDDEN');
    expect(await mgr.fail('role.update', { id: 'Z'.repeat(26), name: 'x' })).toBe('NOT_FOUND');
  });

  it('protects @todos: permissions only, never deleted or reordered', async () => {
    const f = await textFixture();
    const everyone = roleId(f.owner, '@todos');
    expect(await f.owner.fail('role.update', { id: everyone, name: 'todo mundo' })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('role.delete', { id: everyone })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('role.reorder', { ids: [everyone] })).toBe('BAD_REQUEST');
    const { role } = await f.owner.ok<{ role: Role }>('role.update', { id: everyone, permissions: PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CREATE_INVITES });
    expect(role).toMatchObject({ isDefault: true, position: 0, permissions: PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CREATE_INVITES });
    // With CREATE_INVITES on @todos, any member may invite (the owner's choice, spec §6).
    const bia = await f.join();
    await bia.ok('invite.create', {});
  });

  it('member.setRoles respects hierarchy and never grants missing bits', async () => {
    const f = await textFixture();
    const mgr = await f.join();
    const peer = await f.join();
    const target = await f.join();
    const managers = await makeRole(f, 'Gerentes', PERMISSIONS.MANAGE_ROLES);
    const plain = await makeRole(f, 'Comum');
    const powerful = await makeRole(f, 'Banidores', PERMISSIONS.BAN_MEMBERS);
    await f.owner.ok('role.reorder', { ids: [managers.id, powerful.id, plain.id] });
    await give(f, mgr, managers);
    await give(f, peer, managers);
    const { member } = await mgr.ok<{ member: { roleIds: string[] } }>('member.setRoles', { userId: target.userId, roleIds: [plain.id] });
    expect(member.roleIds).toEqual([plain.id]);
    expect(await target.event('member.updated', (d: { member: { userId: string } }) => d.member.userId === target.userId)).toEqual({
      member: expect.objectContaining({ userId: target.userId, roleIds: [plain.id] }),
    });
    expect(await mgr.fail('member.setRoles', { userId: target.userId, roleIds: [powerful.id] })).toBe('FORBIDDEN');
    expect(await mgr.fail('member.setRoles', { userId: target.userId, roleIds: [managers.id] })).toBe('HIERARCHY');
    expect(await mgr.fail('member.setRoles', { userId: peer.userId, roleIds: [] })).toBe('HIERARCHY'); // same rank
    expect(await mgr.fail('member.setRoles', { userId: mgr.userId, roleIds: [] })).toBe('HIERARCHY'); // yourself
    expect(await mgr.fail('member.setRoles', { userId: f.owner.userId, roleIds: [] })).toBe('HIERARCHY');
    expect(await mgr.fail('member.setRoles', { userId: target.userId, roleIds: [roleId(f.owner, '@todos')] })).toBe('BAD_REQUEST');
    expect(await mgr.fail('member.setRoles', { userId: 'f'.repeat(32), roleIds: [] })).toBe('NOT_FOUND');
  });

  it('deleting a role removes it from members and channel lists', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const role = await makeRole(f, 'Temp');
    await give(f, bia, role);
    await f.owner.ok('channel.create', { name: 'temp', type: 'text', private: true, allowedRoleIds: [role.id] });
    await bia.event('channel.created');
    await f.owner.ok('role.delete', { id: role.id });
    expect(await bia.event('role.deleted')).toEqual({ id: role.id });
    expect(await bia.event('channel.deleted')).toBeTruthy();
    withDb(f.t.dataDir, (db) => {
      expect(db.get('SELECT 1 AS x FROM user_roles WHERE role_id = ?', role.id)).toBeUndefined();
      expect(db.get('SELECT 1 AS x FROM channel_allowed_roles WHERE role_id = ?', role.id)).toBeUndefined();
    });
  });

  it('deleting a role tells who still sees a private channel that it left the allowed list', async () => {
    const f = await textFixture();
    const keep = await makeRole(f, 'Staff');
    const gone = await makeRole(f, 'Temp');
    const { channel } = await f.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'equipe', type: 'text', private: true, allowedRoleIds: [keep.id, gone.id] });
    f.owner.clear();
    await f.owner.ok('role.delete', { id: gone.id });
    const updated = await f.owner.event<{ channel: { id: string; allowedRoleIds: string[] } }>('channel.updated', (d) => d.channel.id === channel.id);
    expect(updated.channel.allowedRoleIds).toEqual([keep.id]);
  });
});

describe('kick (spec §7)', () => {
  it('needs KICK_MEMBERS and hierarchy', async () => {
    const f = await textFixture();
    const a = await f.join();
    const b = await f.join();
    expect(await a.fail('member.kick', { userId: b.userId })).toBe('FORBIDDEN');
    const kickers = await makeRole(f, 'Kick', PERMISSIONS.KICK_MEMBERS);
    await give(f, a, kickers);
    await give(f, b, kickers);
    expect(await a.fail('member.kick', { userId: b.userId })).toBe('HIERARCHY');
    expect(await a.fail('member.kick', { userId: f.owner.userId })).toBe('HIERARCHY');
    expect(await a.fail('member.kick', { userId: a.userId })).toBe('HIERARCHY');
    expect(await f.owner.fail('member.kick', { userId: f.owner.userId })).toBe('HIERARCHY');
    expect(await f.owner.fail('member.kick', { userId: 'e'.repeat(32) })).toBe('NOT_FOUND');
  });

  it('ends the session, keeps the messages, announces member.left and blocks rejoining for 10 minutes', async () => {
    const f = await textFixture({ joinMode: 'invite' });
    const invite = await f.owner.ok<{ code: string }>('invite.create', { maxUses: 1 });
    const bia = await f.join({ nickname: 'Bia', inviteCode: invite.code });
    const geral = channelId(bia, 'geral');
    const { message } = await bia.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'fica', clientMsgId: nextClientMsgId() });
    await f.owner.ok('member.kick', { userId: bia.userId });
    await bia.closed;
    expect(bia.closedWith).toBe('KICKED');
    expect(await f.owner.event('member.left')).toEqual({ userId: bia.userId, reason: 'kicked' });
    expect(await f.owner.event('presence', (d: { online: boolean }) => !d.online)).toEqual({ userId: bia.userId, online: false });
    expect((await f.owner.ok<{ messages: Message[] }>('msg.history', { channelId: geral })).messages.map((m) => m.id)).toContain(message.id);
    expect(getUser(f.t.dataDir, bia.userId)).toMatchObject({ removed_at: f.clock.now, rejoin_blocked_until: f.clock.now + 600_000, last_ip: null });

    // Within 10 minutes: blocked. After: invite mode needs a NEW invite (the old one is used up).
    const fresh = await f.owner.ok<{ code: string }>('invite.create', {});
    expect(await f.refused({ seed: bia.seed, nickname: 'Bia', inviteCode: fresh.code })).toBe('REJOIN_BLOCKED');
    f.clock.now += 600_001;
    expect(await f.refused({ seed: bia.seed, nickname: 'Bia' })).toBe('INVITE_REQUIRED');
    expect(await f.refused({ seed: bia.seed, nickname: 'Bia', inviteCode: invite.code })).toBe('INVITE_INVALID');
    const back = await f.join({ seed: bia.seed, nickname: 'Bia', inviteCode: fresh.code });
    expect(back.text.members.find((m) => m.userId === bia.userId)?.roleIds).toEqual([]);
    expect(await f.owner.event('member.joined', (d: { member: { userId: string } }) => d.member.userId === bia.userId)).toBeTruthy();
  });

  it('a kicked member in open mode can come back only after the block', async () => {
    const f = await textFixture();
    const bia = await f.join();
    await f.owner.ok('member.kick', { userId: bia.userId });
    await bia.closed;
    expect(await f.refused({ seed: bia.seed, nickname: bia.nickname })).toBe('REJOIN_BLOCKED');
    f.clock.now += 600_001;
    await f.join({ seed: bia.seed, nickname: bia.nickname });
  });
});

describe('ban (spec §7)', () => {
  it('blocks the identity for good, lists the ban without IPs, and unban lets them back', async () => {
    const f = await textFixture();
    const bia = await f.join({ nickname: 'Bia' });
    const mod = await f.join();
    expect(await mod.fail('member.ban', { userId: bia.userId })).toBe('FORBIDDEN');
    expect(await mod.fail('bans.list', {})).toBe('FORBIDDEN');
    await f.owner.ok('member.ban', { userId: bia.userId, reason: 'spam\u0000' });
    await bia.closed;
    expect(bia.closedWith).toBe('BANNED');
    expect(await mod.event('member.left')).toEqual({ userId: bia.userId, reason: 'banned' });
    f.clock.now += 365 * 24 * 3_600_000;
    expect(await f.refused({ seed: bia.seed, nickname: 'Bia' })).toBe('BANNED');
    const { bans } = await f.owner.ok<{ bans: unknown[] }>('bans.list', {});
    expect(bans).toEqual([{ userId: bia.userId, nickname: 'Bia', reason: 'spam', bannedBy: f.owner.userId, createdAt: f.clock.now - 365 * 24 * 3_600_000 }]);
    expect(JSON.stringify(bans)).not.toContain('127.0.0.1');
    await f.owner.ok('member.unban', { userId: bia.userId });
    expect(await f.owner.fail('member.unban', { userId: bia.userId })).toBe('NOT_FOUND');
    await f.join({ seed: bia.seed, nickname: 'Bia' });
  });

  it('banIp keeps the address so another identity from it is refused too', async () => {
    const f = await textFixture();
    const bia = await f.join();
    await f.owner.ok('member.ban', { userId: bia.userId, banIp: true });
    await bia.closed;
    const row = withDb(f.t.dataDir, (db) => db.get<{ ip: string | null }>('SELECT ip FROM bans WHERE user_id = ?', bia.userId));
    expect(row?.ip).toBe('127.0.0.1');
    // Every test identity connects from 127.0.0.1.
    expect(await f.refused({ nickname: 'Outra' })).toBe('BANNED');
  });

  it('can ban a former member, but never the owner', async () => {
    const f = await textFixture();
    const bia = await f.join();
    await bia.ok('server.leave', {});
    await bia.closed;
    await f.owner.ok('member.ban', { userId: bia.userId });
    expect(await f.refused({ seed: bia.seed, nickname: bia.nickname })).toBe('BANNED');
    expect(await f.owner.fail('member.ban', { userId: f.owner.userId })).toBe('HIERARCHY');
  });
});

describe('server.leave (spec §7)', () => {
  it('the owner must transfer first', async () => {
    const f = await textFixture();
    expect(await f.owner.fail('server.leave', {})).toBe('OWNER_MUST_TRANSFER');
  });

  it('removes membership, reactions and (optionally) messages; rejoining needs the join mode again', async () => {
    const f = await textFixture({ joinMode: 'invite' });
    const inv = await f.owner.ok<{ code: string }>('invite.create', { maxUses: 1 });
    const bia = await f.join({ nickname: 'Bia', inviteCode: inv.code });
    const geral = channelId(bia, 'geral');
    const own = (await f.owner.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'do dono', clientMsgId: nextClientMsgId() })).message;
    const hers = (await bia.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'da bia', clientMsgId: nextClientMsgId() })).message;
    await bia.ok('msg.react', { id: own.id, emoji: '🎉' });
    f.owner.clear();
    await bia.ok('server.leave', { deleteMyMessages: true });
    await bia.closed;
    expect(await f.owner.event('msg.deleted')).toEqual({ id: hers.id, channelId: geral });
    expect(await f.owner.event('msg.reactions')).toEqual({ id: own.id, channelId: geral, reactions: [] });
    expect(await f.owner.event('member.left')).toEqual({ userId: bia.userId, reason: 'left' });
    const history = (await f.owner.ok<{ messages: Message[] }>('msg.history', { channelId: geral })).messages;
    expect(history.map((m) => m.content)).toEqual(['do dono']);
    expect(getUser(f.t.dataDir, bia.userId)).toMatchObject({ removed_at: f.clock.now, rejoin_blocked_until: null, last_ip: null });
    expect(await f.refused({ seed: bia.seed, nickname: 'Bia' })).toBe('INVITE_REQUIRED');
  });

  it('keeps the messages without deleteMyMessages', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(bia, 'geral');
    await bia.ok('msg.send', { channelId: geral, content: 'fica aqui', clientMsgId: nextClientMsgId() });
    await bia.ok('server.leave', {});
    await bia.closed;
    expect((await f.owner.ok<{ messages: Message[] }>('msg.history', { channelId: geral })).messages.map((m) => m.content)).toEqual(['fica aqui']);
  });
});

describe('server.transferOwnership (spec §3.3)', () => {
  it('only the owner, only to a member; the old owner becomes Admin', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const admin = roleId(f.owner, 'Admin');
    expect(await bia.fail('server.transferOwnership', { userId: bia.userId })).toBe('FORBIDDEN');
    expect(await f.owner.fail('server.transferOwnership', { userId: f.owner.userId })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('server.transferOwnership', { userId: 'd'.repeat(32) })).toBe('NOT_FOUND');
    await f.owner.ok('server.transferOwnership', { userId: bia.userId });
    expect(await bia.event('server.updated')).toMatchObject({ ownerId: bia.userId });
    expect(await bia.event('member.updated')).toEqual({ member: expect.objectContaining({ userId: f.owner.userId, roleIds: [admin] }) });
    expect(await f.owner.fail('server.transferOwnership', { userId: f.owner.userId })).toBe('FORBIDDEN');
    // The new owner outranks the Admin role; the old owner can leave now.
    await bia.ok('member.setRoles', { userId: f.owner.userId, roleIds: [] });
    await f.owner.ok('server.leave', {});
    expect(f.text.voiceAccess.isOwner(bia.userId)).toBe(true);
    expect(f.text.voiceAccess.topPosition(bia.userId)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('recreates the Admin role if it was deleted', async () => {
    const f = await textFixture();
    const bia = await f.join();
    await f.owner.ok('role.delete', { id: roleId(f.owner, 'Admin') });
    await f.owner.ok('server.transferOwnership', { userId: bia.userId });
    const { role } = await bia.event<{ role: Role }>('role.created');
    expect(role).toMatchObject({ name: 'Admin', permissions: PERMISSIONS.ADMINISTRATOR });
  });
});
