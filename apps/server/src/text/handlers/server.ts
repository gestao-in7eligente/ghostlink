import {
  CHAT_LIMITS,
  PERMISSIONS,
  ProtocolError,
  has,
  inviteCreateSchema,
  inviteListSchema,
  inviteRevokeSchema,
  sanitizeLabel,
  serverStorageSchema,
  serverTransferSchema,
  serverUpdateSchema,
  type InviteEntry,
  type ServerStorage,
} from '@ghostlink/shared';
import { hashPassword } from '../../auth/password.js';
import { getMeta } from '../../db/serverMeta.js';
import { buildInviteInfo, createInvite } from '../../invites/invites.js';
import type { RequestContext } from '../../modules.js';
import type { TextCore } from '../core.js';
import { newEntityId, toRole } from '../repo.js';
import { ADMIN_SYSTEM_TAG, SEED } from '../seed.js';

type Handler = (core: TextCore, ctx: RequestContext, payload: unknown) => unknown;

/** Addresses come from the server, never from the client (spec §3.5). */
function inviteAddresses(core: TextCore): string[] {
  const stored = getMeta(core.db).publicAddresses;
  return stored.length > 0 ? stored : [`127.0.0.1:${core.port}`];
}

function inviteInfo(core: TextCore, code: string) {
  return buildInviteInfo(code, { addresses: inviteAddresses(core), serverKeyId: core.ctx.serverKeyId, name: getMeta(core.db).name });
}

const inviteCreate: Handler = (core, ctx, payload) => {
  const p = inviteCreateSchema.parse(payload ?? {});
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.CREATE_INVITES);
  if (!core.limiters.invite.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
  const { code } = createInvite(core.db, { maxUses: p.maxUses, expiresInHours: p.expiresInHours, createdBy: ctx.userId, now: core.now() });
  return inviteInfo(core, code);
};

/** Own invites with CREATE_INVITES; everyone's with MANAGE_SERVER (spec §5.2). Only usable invites are listed. */
const inviteList: Handler = (core, ctx, payload) => {
  inviteListSchema.parse(payload ?? {});
  const actor = core.member(ctx.userId);
  const bits = core.access.serverPerms(actor);
  const all = has(bits, PERMISSIONS.MANAGE_SERVER);
  if (!all && !has(bits, PERMISSIONS.CREATE_INVITES)) throw new ProtocolError('FORBIDDEN');
  const rows = core.db.all<{ code: string; created_by: string | null; created_at: number; expires_at: number | null; max_uses: number | null; uses: number }>(
    `SELECT code, created_by, created_at, expires_at, max_uses, uses FROM invites
     WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)
       AND (? = 1 OR created_by = ?)
     ORDER BY created_at DESC LIMIT 500`,
    core.now(), all ? 1 : 0, ctx.userId,
  );
  const invites: InviteEntry[] = rows.map((r) => ({
    code: r.code,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    maxUses: r.max_uses === null ? null : Number(r.max_uses),
    uses: Number(r.uses),
    webLink: inviteInfo(core, r.code).webLink,
  }));
  return { invites };
};

const inviteRevoke: Handler = (core, ctx, payload) => {
  const p = inviteRevokeSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const bits = core.access.serverPerms(actor);
  const all = has(bits, PERMISSIONS.MANAGE_SERVER);
  if (!all && !has(bits, PERMISSIONS.CREATE_INVITES)) throw new ProtocolError('FORBIDDEN');
  const row = core.db.get<{ created_by: string | null }>('SELECT created_by FROM invites WHERE code = ? AND revoked = 0', p.code);
  // Someone else's invite is invisible without MANAGE_SERVER: the same answer as a missing one.
  if (!row || (!all && row.created_by !== ctx.userId)) throw new ProtocolError('NOT_FOUND');
  core.db.run('UPDATE invites SET revoked = 1 WHERE code = ?', p.code);
  return {};
};

const serverUpdate: Handler = async (core, ctx, payload) => {
  const p = serverUpdateSchema.parse(payload);
  core.access.requireServer(core.member(ctx.userId), PERMISSIONS.MANAGE_SERVER);
  const name = p.name === undefined ? undefined : sanitizeLabel(p.name, CHAT_LIMITS.serverNameMax);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty server name');
  // scrypt runs outside any transaction (and behind its own concurrency limit).
  const passwordHash = typeof p.password === 'string' ? await hashPassword(p.password) : p.password;
  // After the await: the session may be gone and the permission may have changed (spec §5.1).
  if (!ctx.isCurrent()) throw new ProtocolError('FORBIDDEN');
  core.access.requireServer(core.member(ctx.userId), PERMISSIONS.MANAGE_SERVER);
  const meta = getMeta(core.db);
  const joinMode = p.joinMode ?? meta.joinMode;
  const hasPassword = passwordHash === undefined ? meta.passwordHash !== null : passwordHash !== null;
  if (joinMode === 'password' && !hasPassword) throw new ProtocolError('BAD_REQUEST', 'password mode needs a password');
  core.db.run(
    'UPDATE server_meta SET name = ?, join_mode = ?, password_hash = ?, max_members = ?, upload_limit_mb = ?, storage_quota_mb = ? WHERE id = 1',
    name ?? meta.name,
    joinMode,
    passwordHash === undefined ? meta.passwordHash : passwordHash,
    p.maxMembers ?? meta.maxMembers,
    // New limits apply to the next uploads; files already stored stay (spec 2026-10-01-anexos §2).
    p.uploadLimitMb ?? meta.uploadLimitMb,
    p.storageQuotaMb ?? meta.storageQuotaMb,
  );
  const d = core.serverInfo();
  core.broadcastAll({ t: 'server.updated', d });
  return d;
};

/** Bytes of every stored attachment, used or still waiting for its message. */
export function storageUsedBytes(core: Pick<TextCore, 'db'>): number {
  return Number(core.db.get<{ n: number | null }>('SELECT SUM(size) AS n FROM files')?.n ?? 0);
}

/** `server.storage {}` (spec 2026-10-01-anexos §2: Server settings → Overview shows the space used). */
const serverStorage: Handler = (core, ctx, payload) => {
  serverStorageSchema.parse(payload ?? {});
  core.access.requireServer(core.member(ctx.userId), PERMISSIONS.MANAGE_SERVER);
  const meta = getMeta(core.db);
  const result: ServerStorage = { usedBytes: storageUsedBytes(core), uploadLimitMb: meta.uploadLimitMb, storageQuotaMb: meta.storageQuotaMb };
  return result;
};

/** Owner only, to a current member; the old owner keeps power through the Admin role (spec §3.3). */
const transferOwnership: Handler = (core, ctx, payload) => {
  const p = serverTransferSchema.parse(payload);
  core.member(ctx.userId);
  if (!core.access.isOwner(ctx.userId)) throw new ProtocolError('FORBIDDEN');
  if (p.userId === ctx.userId) throw new ProtocolError('BAD_REQUEST', 'already the owner');
  if (!core.access.subject(p.userId).isMember) throw new ProtocolError('NOT_FOUND');
  const { db } = core;
  let adminId = db.get<{ id: string }>('SELECT id FROM roles WHERE system_tag = ?', ADMIN_SYSTEM_TAG)?.id;
  const created = adminId === undefined;
  core.withVisibility(() => db.tx(() => {
    if (adminId === undefined) {
      adminId = newEntityId();
      const top = db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM roles');
      db.run(
        `INSERT INTO roles (id, name, color, permissions, position, hoist, mentionable, is_default, system_tag)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
        adminId, SEED.adminName, SEED.adminColor, PERMISSIONS.ADMINISTRATOR, Number(top?.p ?? 0) + 1, ADMIN_SYSTEM_TAG,
      );
    }
    db.run('UPDATE server_meta SET owner_user_id = ? WHERE id = 1', p.userId);
    db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', ctx.userId, adminId);
  }));
  const role = core.repo.role(adminId!);
  if (created && role) core.broadcastAll({ t: 'role.created', d: { role: toRole(role) } });
  core.broadcastAll({ t: 'member.updated', d: { member: core.repo.member(ctx.userId, core.isOnline(ctx.userId)) } });
  core.broadcastAll({ t: 'server.updated', d: core.serverInfo() });
  core.events.emit('access.changed', { userIds: [ctx.userId, p.userId] });
  return {};
};

export const serverHandlers: Record<string, Handler> = {
  'invite.create': inviteCreate,
  'invite.list': inviteList,
  'invite.revoke': inviteRevoke,
  'server.update': serverUpdate,
  'server.storage': serverStorage,
  'server.transferOwnership': transferOwnership,
};
