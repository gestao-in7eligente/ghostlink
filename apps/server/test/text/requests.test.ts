import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Message } from '@ghostlink/shared';
import type { ServerModule } from '../../src/index.js';
import { getVoiceAccess, type TextEventMap, type TextModule } from '../../src/text/index.js';
import { getOwner, withDb } from '../helpers/db.js';
import { channelId, nextClientMsgId, roleId, textFixture } from './helpers.js';

const SOME_ROLE = 'Q'.repeat(26);
const SOME_USER = '0'.repeat(32);

describe('every privileged request is refused to a plain member (forbidden path)', () => {
  it.each<[string, (ids: { user: string; role: string; channel: string }) => unknown]>([
    ['channel.create', () => ({ name: 'x', type: 'text' })],
    ['channel.update', (i) => ({ id: i.channel, name: 'x' })],
    ['channel.delete', (i) => ({ id: i.channel })],
    ['channel.reorder', (i) => ({ ids: [i.channel] })],
    ['role.create', () => ({ name: 'x' })],
    ['role.update', (i) => ({ id: i.role, name: 'x' })],
    ['role.delete', (i) => ({ id: i.role })],
    ['role.reorder', (i) => ({ ids: [i.role] })],
    ['member.setRoles', (i) => ({ userId: i.user, roleIds: [] })],
    ['member.kick', (i) => ({ userId: i.user })],
    ['member.ban', (i) => ({ userId: i.user })],
    ['member.unban', (i) => ({ userId: i.user })],
    ['bans.list', () => ({})],
    ['invite.create', () => ({})],
    ['invite.list', () => ({})],
    ['invite.revoke', () => ({ code: 'ABCDEFGHIJ' })],
    ['server.update', () => ({ name: 'x' })],
    ['server.transferOwnership', (i) => ({ userId: i.user })],
  ])('%s → FORBIDDEN', async (type, payload) => {
    const f = await textFixture();
    const member = await f.join();
    const other = await f.join();
    const ids = { user: other.userId, role: roleId(f.owner, 'Admin'), channel: channelId(f.owner, 'geral') };
    expect(await member.fail(type, payload(ids))).toBe('FORBIDDEN');
    // Nothing changed.
    const after = await f.join({ seed: member.seed, nickname: member.nickname });
    expect(after.text.channels.map((c) => c.name)).toEqual(['geral', 'Sala de voz']);
    expect(after.text.roles.map((r) => r.name).sort()).toEqual(['@todos', 'Admin']);
    expect(after.text.members).toHaveLength(3);
    expect(getOwner(f.t.dataDir)).toBe(f.owner.userId);
  });

  it('members without SEND_MESSAGES or ADD_REACTIONS cannot write, type or react', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(bia, 'geral');
    const { message } = await f.owner.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId() });
    await f.owner.ok('role.update', { id: roleId(f.owner, '@todos'), permissions: PERMISSIONS.VIEW_CHANNEL });
    expect(await bia.fail('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId() })).toBe('FORBIDDEN');
    expect(await bia.fail('typing', { channelId: geral })).toBe('FORBIDDEN');
    expect(await bia.fail('msg.react', { id: message.id, emoji: '👍' })).toBe('FORBIDDEN');
    // Reading still works.
    await bia.ok('msg.history', { channelId: geral });
    await bia.ok('channel.read', { channelId: geral, messageId: message.id });
  });
});

describe('channel limit', () => {
  it('refuses channels past the limit, so channel.reorder always fits', async () => {
    const f = await textFixture({ text: { maxChannels: 3 } });
    await f.owner.ok('channel.create', { name: 'terceiro', type: 'text' });
    expect(await f.owner.fail('channel.create', { name: 'quarto', type: 'text' })).toBe('BAD_REQUEST');
  });
});

describe('strict payloads (spec §5.1: unknown keys → BAD_REQUEST)', () => {
  it.each<[string, unknown]>([
    ['channel.create', { name: 'x', type: 'text', position: 0 }],
    ['channel.update', { id: SOME_ROLE, type: 'voice' }],
    ['channel.delete', { id: SOME_ROLE, force: true }],
    ['channel.reorder', { ids: 'x' }],
    ['channel.read', { channelId: SOME_ROLE }],
    ['msg.history', { channelId: SOME_ROLE, after: 1 }],
    ['msg.send', { channelId: SOME_ROLE, content: 'x' }],
    ['msg.edit', { id: 1, content: 'x', channelId: SOME_ROLE }],
    ['msg.delete', { id: '1' }],
    ['msg.react', { id: 1, emoji: '👍', count: 2 }],
    ['msg.unreact', { id: 1 }],
    ['typing', { channelId: SOME_ROLE, extra: true }],
    ['profile.update', { nickname: 'x', avatarFileId: null }],
    ['role.create', { name: 'x', isDefault: true }],
    ['role.update', { id: SOME_ROLE, position: 5 }],
    ['role.delete', {}],
    ['role.reorder', { ids: [] }],
    ['member.setRoles', { userId: SOME_USER }],
    ['member.kick', { userId: SOME_USER, reason: 'x' }],
    ['member.ban', { userId: SOME_USER, days: 7 }],
    ['member.unban', { userId: 'nope' }],
    ['bans.list', { page: 2 }],
    ['invite.create', { maxUses: 0 }],
    ['invite.list', { all: true }],
    ['invite.revoke', { code: 'short' }],
    ['server.update', { iconFileId: SOME_ROLE }],
    ['server.transferOwnership', { userId: SOME_USER, confirm: true }],
    ['server.leave', { deleteMyMessages: 'yes' }],
  ])('%s', async (type, payload) => {
    const f = await textFixture();
    expect(await f.owner.fail(type, payload)).toBe('BAD_REQUEST');
  });
});

describe('rate limits (spec §13)', () => {
  it('msg.send: burst of 10, then 1 per second (5 every 5 s)', async () => {
    const f = await textFixture();
    const geral = channelId(f.owner, 'geral');
    const send = () => f.owner.request('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId() });
    for (let i = 0; i < 10; i++) expect((await send()).ok).toBe(true);
    expect((await send()).error?.code).toBe('RATE_LIMITED');
    f.clock.now += 1_000;
    expect((await send()).ok).toBe(true);
    expect((await send()).error?.code).toBe('RATE_LIMITED');
    f.clock.now += 5_000;
    for (let i = 0; i < 5; i++) expect((await send()).ok).toBe(true);
  });

  it('typing: 1 every 3 s; msg.react: 10 every 5 s; profile.update: 5 per minute', async () => {
    const f = await textFixture();
    const geral = channelId(f.owner, 'geral');
    await f.owner.ok('typing', { channelId: geral });
    expect(await f.owner.fail('typing', { channelId: geral })).toBe('RATE_LIMITED');
    f.clock.now += 3_001;
    await f.owner.ok('typing', { channelId: geral });

    const { message } = await f.owner.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'x', clientMsgId: nextClientMsgId() });
    for (let i = 0; i < 10; i++) await f.owner.ok(i % 2 ? 'msg.unreact' : 'msg.react', { id: message.id, emoji: '👍' });
    expect(await f.owner.fail('msg.react', { id: message.id, emoji: '👍' })).toBe('RATE_LIMITED');
    f.clock.now += 5_001;
    await f.owner.ok('msg.react', { id: message.id, emoji: '👍' });

    for (let i = 0; i < 5; i++) await f.owner.ok('profile.update', { nickname: `Dono ${i}` });
    expect(await f.owner.fail('profile.update', { nickname: 'Dono 9' })).toBe('RATE_LIMITED');
  });

  it('msg.edit: an edit re-broadcasts the whole message, so it gets the msg.send limit too', async () => {
    const f = await textFixture();
    const bia = await f.join();
    const geral = channelId(f.owner, 'geral');
    const { message } = await f.owner.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'v0', clientMsgId: nextClientMsgId() });
    // Its own bucket: sending does not use up edits, nor the other way round.
    for (let i = 1; i <= 10; i++) await f.owner.ok('msg.edit', { id: message.id, content: `v${i}` });
    expect(await f.owner.fail('msg.edit', { id: message.id, content: 'v11' })).toBe('RATE_LIMITED');
    await f.owner.ok('msg.send', { channelId: geral, content: 'still free', clientMsgId: nextClientMsgId() });
    // An edit that changes nothing broadcasts nothing and costs nothing.
    await f.owner.ok('msg.edit', { id: message.id, content: 'v10' });
    f.clock.now += 1_000;
    await f.owner.ok('msg.edit', { id: message.id, content: 'v11' });
    expect(await f.owner.fail('msg.edit', { id: message.id, content: 'v12' })).toBe('RATE_LIMITED');
    await bia.sync();
    expect(bia.seen<{ message: Message }>('msg.updated').map((d) => d.message.content)).toEqual([...Array.from({ length: 10 }, (_, i) => `v${i + 1}`), 'v11']);
  });

  it('invite.create: 10 per hour per user', async () => {
    const f = await textFixture();
    for (let i = 0; i < 10; i++) await f.owner.ok('invite.create', {});
    expect(await f.owner.fail('invite.create', {})).toBe('RATE_LIMITED');
    f.clock.now += 3_600_001;
    await f.owner.ok('invite.create', {});
  });
});

describe('invites (spec §3.5, §5.2)', () => {
  it('creates links from the server addresses, lists own vs all, revokes', async () => {
    const f = await textFixture({ joinMode: 'invite' });
    const inviters = (await f.owner.ok<{ role: { id: string } }>('role.create', { name: 'Convidam', permissions: PERMISSIONS.CREATE_INVITES })).role;
    const own = await f.owner.ok<{ code: string; link: string; pasteCode: string; webLink: string }>('invite.create', { maxUses: 2, expiresInHours: 24 });
    expect(own.code).toMatch(/^[A-Z2-7]{10}$/);
    expect(own.link).toContain(`127.0.0.1%3A${f.t.server.port}`);
    expect(own.link).toContain(f.t.server.serverKeyId);
    expect(own.pasteCode).toMatch(/^GL1-/);
    expect(own.webLink).toContain('#GL1-');
    const bia = await f.join({ inviteCode: own.code });
    await f.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [inviters.id] });
    const hers = await bia.ok<{ code: string }>('invite.create', {});
    expect((await bia.ok<{ invites: Array<{ code: string }> }>('invite.list', {})).invites.map((i) => i.code)).toEqual([hers.code]);
    const all = (await f.owner.ok<{ invites: Array<{ code: string; uses: number; maxUses: number | null }> }>('invite.list', {})).invites;
    expect(all.map((i) => i.code).sort()).toEqual([own.code, hers.code].sort());
    expect(all.find((i) => i.code === own.code)).toMatchObject({ uses: 1, maxUses: 2 });
    // Someone else's invite is invisible without MANAGE_SERVER.
    expect(await bia.fail('invite.revoke', { code: own.code })).toBe('NOT_FOUND');
    await bia.ok('invite.revoke', { code: hers.code });
    await f.owner.ok('invite.revoke', { code: own.code });
    expect(await f.refused({ inviteCode: own.code })).toBe('INVITE_INVALID');
    expect(await f.owner.fail('invite.revoke', { code: own.code })).toBe('NOT_FOUND');
  });
});

describe('server.update (spec §5.2)', () => {
  it('updates name, join mode, password and member limit, and announces it', async () => {
    const f = await textFixture();
    const bia = await f.join();
    expect(await f.owner.fail('server.update', { joinMode: 'password' })).toBe('BAD_REQUEST'); // no password yet
    const d = await f.owner.ok('server.update', { name: '  Casa‮  ', joinMode: 'password', password: 'segredo', maxMembers: 50 });
    expect(d).toEqual({ name: 'Casa', joinMode: 'password', ownerId: f.owner.userId, maxMembers: 50, hasPassword: true, uploadLimitMb: 25, storageQuotaMb: 10_240, icon: null });
    expect(await bia.event('server.updated')).toEqual(d);
    expect(JSON.stringify(bia.events)).not.toContain('scrypt');
    expect(await f.refused({ password: 'errada' })).toBe('BAD_PASSWORD');
    await f.join({ password: 'segredo' });
    expect(await f.owner.fail('server.update', { password: null })).toBe('BAD_REQUEST'); // still in password mode
    await f.owner.ok('server.update', { joinMode: 'open', password: null });
    withDb(f.t.dataDir, (db) => expect(db.get('SELECT password_hash FROM server_meta')).toEqual({ password_hash: null }));
    expect(await f.owner.fail('server.update', { name: '​' })).toBe('BAD_REQUEST');
  });
});

describe('presence (spec §5.1)', () => {
  it('goes offline only after the grace period, and a quick reconnect is invisible', async () => {
    const f = await textFixture({ limits: { presenceGraceMs: 300 } });
    const bia = await f.join();
    await f.owner.event('presence');
    f.owner.clear();
    bia.close();
    const back = await f.join({ seed: bia.seed, nickname: bia.nickname });
    await new Promise((r) => setTimeout(r, 400));
    await f.owner.sync();
    expect(f.owner.seen('presence')).toEqual([]);
    back.close();
    expect(await f.owner.event('presence', undefined, 2_000)).toEqual({ userId: bia.userId, online: false });
  });
});

describe('seams for the Voice module', () => {
  it('exposes VoiceAccess through getVoiceAccess(ctx) and emits in-process signals', async () => {
    const seen: Array<[keyof TextEventMap, unknown]> = [];
    let access: ReturnType<typeof getVoiceAccess> | null = null;
    const voiceProbe: ServerModule = {
      name: 'voice-probe',
      init(ctx) {
        access = getVoiceAccess(ctx);
        const text = ctx.getModule<TextModule>('text');
        for (const e of ['membership.removed', 'access.changed', 'channel.deleted', 'visibility.changed'] as const) {
          text.events.on(e, (p) => seen.push([e, p]));
        }
      },
    };
    const f = await textFixture({ extraModules: [voiceProbe] });
    const voice = channelId(f.owner, 'Sala de voz');
    const bia = await f.join();
    const cat = await f.join();
    expect(access!.channel(voice)).toEqual({ type: 'voice', userLimit: 0 });
    expect(access!.permissions(bia.userId, voice) & PERMISSIONS.CONNECT_VOICE).toBeTruthy();
    expect(access!.isOwner(f.owner.userId)).toBe(true);
    expect(access!.topPosition(bia.userId)).toBe(0);

    await f.owner.ok('channel.update', { id: voice, userLimit: 5 });
    expect(access!.channel(voice)).toEqual({ type: 'voice', userLimit: 5 });
    await f.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [roleId(f.owner, 'Admin')] });
    expect(access!.topPosition(bia.userId)).toBe(1);
    await f.owner.ok('member.kick', { userId: cat.userId });
    expect(access!.permissions(cat.userId, voice)).toBe(0);
    await f.owner.ok('channel.delete', { id: voice });

    expect(seen).toContainEqual(['access.changed', { userIds: [bia.userId] }]);
    expect(seen).toContainEqual(['membership.removed', { userId: cat.userId, reason: 'kicked' }]);
    expect(seen).toContainEqual(['channel.deleted', { channelId: voice, type: 'voice' }]);
    expect(seen).toContainEqual(['visibility.changed', { userId: bia.userId, gained: [], lost: [voice] }]);
  });

  it('a throwing listener never breaks the request', async () => {
    const boom: ServerModule = {
      name: 'boom',
      init(ctx) {
        ctx.getModule<TextModule>('text').events.on('membership.removed', () => {
          throw new Error('listener bug');
        });
      },
    };
    const f = await textFixture({ extraModules: [boom] });
    const bia = await f.join();
    await f.owner.ok('member.kick', { userId: bia.userId });
  });
});
