import {
  CHAT_LIMITS,
  PERMISSIONS,
  ProtocolError,
  bansListSchema,
  canActOn,
  cleanMessageContent,
  memberBanSchema,
  memberKickSchema,
  memberUnbanSchema,
  normalizeNickname,
  profileUpdateSchema,
  serverLeaveSchema,
  type BanEntry,
  type ErrorCode,
  type MemberLeftReason,
} from '@ghostlink/shared';
import type { RequestContext } from '../../modules.js';
import { ipKey } from '../../ratelimit/limiter.js';
import type { TextCore } from '../core.js';
import type { ChannelRow } from '../repo.js';
import { softDeleteMessage } from './messages.js';

type Handler = (core: TextCore, ctx: RequestContext, payload: unknown) => unknown;

/** A rejoin after a kick is blocked for 10 minutes (spec §7). */
export const KICK_REJOIN_BLOCK_MS = 10 * 60_000;

/**
 * Ends a membership (spec §7): the caller already updated the database. The
 * session closes with `code` (no presence grace), everyone learns
 * `member.left`, and other modules get `membership.removed` (voice disconnects).
 */
function finishRemoval(core: TextCore, userId: string, reason: MemberLeftReason, code: ErrorCode | null): void {
  core.knownMembers.delete(userId);
  if (code !== null) core.ctx.sessions.closeUser(userId, code);
  core.broadcastAll({ t: 'member.left', d: { userId, reason } });
  core.events.emit('membership.removed', { userId, reason });
}

/** Membership data that ends with the membership. Call inside db.tx. */
function dropMembership(core: TextCore, userId: string): void {
  core.db.run('DELETE FROM user_roles WHERE user_id = ?', userId);
  core.db.run('DELETE FROM read_states WHERE user_id = ?', userId);
  core.db.run('DELETE FROM mentions WHERE user_id = ?', userId);
}

const kick: Handler = (core, ctx, payload) => {
  const p = memberKickSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.KICK_MEMBERS);
  const target = core.access.subject(p.userId);
  if (!target.isMember) throw new ProtocolError('NOT_FOUND');
  if (!canActOn(actor, target)) throw new ProtocolError('HIERARCHY');
  const now = core.now();
  core.db.tx(() => {
    dropMembership(core, p.userId);
    // Messages stay. last_ip is personal data kept only while a member or IP-banned (spec §7).
    core.db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = ?, last_ip = NULL WHERE id = ?', now, now + KICK_REJOIN_BLOCK_MS, p.userId);
  });
  finishRemoval(core, p.userId, 'kicked', 'KICKED');
  return {};
};

const ban: Handler = (core, ctx, payload) => {
  const p = memberBanSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.BAN_MEMBERS);
  const user = core.repo.user(p.userId);
  if (!user) throw new ProtocolError('NOT_FOUND');
  // Former members can be banned too; a removed user has no roles, so only the owner is protected.
  const target = core.access.subject(p.userId);
  if (!canActOn(actor, { isOwner: core.access.isOwner(p.userId), roles: target.roles })) throw new ProtocolError('HIERARCHY');
  const ip = p.banIp && user.last_ip ? ipKey(user.last_ip) : null;
  const reason = p.reason === undefined ? null : cleanMessageContent(p.reason).slice(0, CHAT_LIMITS.banReasonMax) || null;
  const now = core.now();
  core.db.tx(() => {
    core.db.run(
      `INSERT INTO bans (user_id, public_key, ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key, ip = excluded.ip, reason = excluded.reason,
         banned_by = excluded.banned_by, created_at = excluded.created_at`,
      p.userId, user.public_key, ip, reason, ctx.userId, now,
    );
    dropMembership(core, p.userId);
    core.db.run(
      `UPDATE users SET removed_at = COALESCE(removed_at, ?), rejoin_blocked_until = NULL,
         last_ip = CASE WHEN ? THEN last_ip ELSE NULL END WHERE id = ?`,
      now, ip === null ? 0 : 1, p.userId,
    );
  });
  if (target.isMember) finishRemoval(core, p.userId, 'banned', 'BANNED');
  else core.ctx.sessions.closeUser(p.userId, 'BANNED');
  return {};
};

const unban: Handler = (core, ctx, payload) => {
  const p = memberUnbanSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.BAN_MEMBERS);
  if (core.db.run('DELETE FROM bans WHERE user_id = ?', p.userId).changes === 0) throw new ProtocolError('NOT_FOUND');
  return {};
};

const bansList: Handler = (core, ctx, payload) => {
  bansListSchema.parse(payload ?? {});
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.BAN_MEMBERS);
  // Never the IP (spec §7): only who, why, by whom and when.
  const bans: BanEntry[] = core.db
    .all<{ user_id: string; nickname: string | null; reason: string | null; banned_by: string | null; created_at: number }>(
      `SELECT b.user_id, u.nickname, b.reason, b.banned_by, b.created_at FROM bans b
       LEFT JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC`,
    )
    .map((b) => ({ userId: b.user_id, nickname: b.nickname ?? '', reason: b.reason, bannedBy: b.banned_by, createdAt: Number(b.created_at) }));
  return { bans };
};

const profile: Handler = (core, ctx, payload) => {
  const p = profileUpdateSchema.parse(payload);
  core.member(ctx.userId);
  if (!core.limiters.profile.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
  const nick = normalizeNickname(p.nickname);
  const taken = core.db.get('SELECT 1 AS x FROM users WHERE nickname_norm = ? AND id <> ?', nick.norm, ctx.userId);
  if (taken) throw new ProtocolError('NICK_TAKEN');
  core.db.run('UPDATE users SET nickname = ?, nickname_norm = ? WHERE id = ?', nick.display, nick.norm, ctx.userId);
  const member = core.repo.member(ctx.userId, core.isOnline(ctx.userId));
  core.broadcastAll({ t: 'member.updated', d: { member } });
  return { member };
};

/**
 * Leaving (spec §7): membership, reactions and read state go; with
 * deleteMyMessages the messages are cleared too. The owner must transfer first.
 */
const leave: Handler = (core, ctx, payload) => {
  const p = serverLeaveSchema.parse(payload ?? {});
  core.member(ctx.userId);
  if (core.access.isOwner(ctx.userId)) throw new ProtocolError('OWNER_MUST_TRANSFER');
  const userId = ctx.userId;
  const reacted = core.db.all<{ message_id: number }>('SELECT DISTINCT message_id FROM reactions WHERE user_id = ?', userId).map((r) => Number(r.message_id));
  const mine = p.deleteMyMessages
    ? core.db.all<{ id: number }>('SELECT id FROM messages WHERE user_id = ? AND deleted_at IS NULL', userId).map((r) => Number(r.id))
    : [];
  const deleted = new Set(mine);
  // Channels are resolved before the user loses access, but events go out after, to the remaining viewers.
  const channelOf = new Map<number, string>();
  for (const id of [...reacted, ...mine]) {
    const row = core.repo.message(id);
    if (row) channelOf.set(id, row.channel_id);
  }
  core.db.tx(() => {
    core.db.run('DELETE FROM reactions WHERE user_id = ?', userId);
    for (const id of mine) softDeleteMessage(core, id);
    dropMembership(core, userId);
    core.db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = NULL, last_ip = NULL, avatar_file_id = NULL WHERE id = ?', core.now(), userId);
  });
  // One audience per channel, however many messages it had (a big leave stays cheap).
  const audiences = new Map<string, { channel: ChannelRow; audience: (userId: string) => boolean } | null>();
  const target = (messageId: number) => {
    const channelId = channelOf.get(messageId) ?? '';
    if (!audiences.has(channelId)) {
      const channel = core.repo.channel(channelId);
      audiences.set(channelId, channel ? { channel, audience: core.access.audience(channel) } : null);
    }
    return audiences.get(channelId) ?? null;
  };
  for (const id of mine) {
    const to = target(id);
    if (to) core.broadcastChannel(to.channel, { t: 'msg.deleted', d: { id, channelId: to.channel.id } }, undefined, to.audience);
  }
  for (const id of reacted) {
    if (deleted.has(id)) continue;
    const to = target(id);
    if (to) core.broadcastChannel(to.channel, { t: 'msg.reactions', d: { id, channelId: to.channel.id, reactions: core.repo.reactions(id) } }, undefined, to.audience);
  }
  if (mine.length > 0) core.events.emit('messages.deleted', { ids: mine });
  finishRemoval(core, userId, 'left', null);
  // The response goes out first; then the (now non-member) session ends.
  const timer = setTimeout(() => core.ctx.sessions.closeUser(userId, 'KICKED'), 0);
  timer.unref();
  return {};
};

export const memberHandlers: Record<string, Handler> = {
  'member.kick': kick,
  'member.ban': ban,
  'member.unban': unban,
  'bans.list': bansList,
  'profile.update': profile,
  'server.leave': leave,
};
