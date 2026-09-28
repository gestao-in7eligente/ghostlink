import {
  PERMISSIONS,
  ProtocolError,
  ROLE_LIMITS,
  canActOn,
  canGrant,
  canManageRole,
  memberSetRolesSchema,
  roleCreateSchema,
  roleDeleteSchema,
  roleReorderSchema,
  roleUpdateSchema,
  sanitizeLabel,
} from '@ghostlink/shared';
import type { RequestContext } from '../../modules.js';
import type { TextCore } from '../core.js';
import { newEntityId, toRole, type RoleRow } from '../repo.js';

type Handler = (core: TextCore, ctx: RequestContext, payload: unknown) => unknown;

function roleName(raw: string): string {
  const name = sanitizeLabel(raw, ROLE_LIMITS.nameMax);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty role name');
  return name;
}

function announceRole(core: TextCore, id: string, t: 'role.created' | 'role.updated'): void {
  const row = core.repo.role(id);
  if (row) core.broadcastAll({ t, d: { role: toRole(row) } });
}

const create: Handler = (core, ctx, payload) => {
  const p = roleCreateSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const bits = core.access.requireServer(actor, PERMISSIONS.MANAGE_ROLES);
  const permissions = p.permissions ?? 0;
  // Nobody grants a bit they do not have (spec §6).
  if (!canGrant(bits, permissions)) throw new ProtocolError('FORBIDDEN');
  const name = roleName(p.name);
  const count = core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM roles');
  if (Number(count?.n ?? 0) >= ROLE_LIMITS.maxRoles) throw new ProtocolError('BAD_REQUEST', 'too many roles');
  const id = newEntityId();
  // New roles start at the bottom (position 1), so their creator can always manage them.
  const shifted = core.db.all<{ id: string }>('SELECT id FROM roles WHERE is_default = 0').map((r) => r.id);
  core.db.tx(() => {
    core.db.run('UPDATE roles SET position = position + 1 WHERE is_default = 0');
    core.db.run(
      'INSERT INTO roles (id, name, color, permissions, position, hoist, mentionable, is_default) VALUES (?, ?, ?, ?, 1, ?, ?, 0)',
      id, name, p.color ?? 0, permissions, p.hoist ? 1 : 0, p.mentionable ? 1 : 0,
    );
  });
  announceRole(core, id, 'role.created');
  for (const other of shifted) announceRole(core, other, 'role.updated');
  return { role: toRole(core.repo.role(id)!) };
};

const update: Handler = (core, ctx, payload) => {
  const p = roleUpdateSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const bits = core.access.requireServer(actor, PERMISSIONS.MANAGE_ROLES);
  const role = core.repo.role(p.id);
  if (!role) throw new ProtocolError('NOT_FOUND');
  if (!canManageRole(actor, { position: Number(role.position) })) throw new ProtocolError('HIERARCHY');
  if (p.permissions !== undefined && !canGrant(bits, p.permissions, Number(role.permissions))) throw new ProtocolError('FORBIDDEN');
  const isDefault = role.is_default === 1;
  // `@everyone` only has permissions: its name, color and flags are fixed.
  if (isDefault && (p.name !== undefined || p.color !== undefined || p.hoist !== undefined || p.mentionable !== undefined)) {
    throw new ProtocolError('BAD_REQUEST', '@everyone only has permissions');
  }
  const next = {
    name: p.name === undefined ? role.name : roleName(p.name),
    color: p.color ?? Number(role.color),
    permissions: p.permissions ?? Number(role.permissions),
    hoist: p.hoist === undefined ? role.hoist : p.hoist ? 1 : 0,
    mentionable: p.mentionable === undefined ? role.mentionable : p.mentionable ? 1 : 0,
  };
  const members = isDefault ? null : core.repo.roleMembers(role.id);
  // VIEW_CHANNEL on a role (or on @everyone) changes who sees which channel.
  core.withVisibility(() => core.db.run(
    'UPDATE roles SET name = ?, color = ?, permissions = ?, hoist = ?, mentionable = ? WHERE id = ?',
    next.name, next.color, next.permissions, next.hoist, next.mentionable, role.id,
  ));
  announceRole(core, role.id, 'role.updated');
  if (next.permissions !== Number(role.permissions)) core.events.emit('access.changed', { userIds: members });
  return { role: toRole(core.repo.role(role.id)!) };
};

const remove: Handler = (core, ctx, payload) => {
  const p = roleDeleteSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_ROLES);
  const role = core.repo.role(p.id);
  if (!role) throw new ProtocolError('NOT_FOUND');
  if (role.is_default === 1) throw new ProtocolError('BAD_REQUEST', '@everyone cannot be deleted');
  if (!canManageRole(actor, { position: Number(role.position) })) throw new ProtocolError('HIERARCHY');
  const members = core.repo.roleMembers(role.id);
  // user_roles and channel_allowed_roles rows go with it (ON DELETE CASCADE).
  core.withVisibility(() => core.db.tx(() => core.db.run('DELETE FROM roles WHERE id = ?', role.id)));
  core.broadcastAll({ t: 'role.deleted', d: { id: role.id } });
  core.events.emit('access.changed', { userIds: members });
  return {};
};

/** `ids`: roles below the actor's top role, strongest first; they swap among the positions they hold. */
const reorder: Handler = (core, ctx, payload) => {
  const p = roleReorderSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_ROLES);
  if (new Set(p.ids).size !== p.ids.length) throw new ProtocolError('BAD_REQUEST', 'duplicate ids');
  const rows: RoleRow[] = p.ids.map((id) => {
    const role = core.repo.role(id);
    if (!role) throw new ProtocolError('NOT_FOUND');
    if (role.is_default === 1) throw new ProtocolError('BAD_REQUEST', '@everyone is always last');
    if (!canManageRole(actor, { position: Number(role.position) })) throw new ProtocolError('HIERARCHY');
    return role;
  });
  const slots = rows.map((r) => Number(r.position)).sort((a, b) => b - a);
  const changed: string[] = [];
  core.db.tx(() => {
    rows.forEach((role, i) => {
      if (Number(role.position) === slots[i]) return;
      core.db.run('UPDATE roles SET position = ? WHERE id = ?', slots[i]!, role.id);
      changed.push(role.id);
    });
  });
  for (const id of changed) announceRole(core, id, 'role.updated');
  return {};
};

const setRoles: Handler = (core, ctx, payload) => {
  const p = memberSetRolesSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const bits = core.access.requireServer(actor, PERMISSIONS.MANAGE_ROLES);
  const target = core.access.subject(p.userId);
  if (!target.isMember) throw new ProtocolError('NOT_FOUND');
  if (!canActOn(actor, target)) throw new ProtocolError('HIERARCHY');
  const wanted = new Map<string, RoleRow>();
  for (const id of p.roleIds) {
    const role = core.repo.role(id);
    if (!role) throw new ProtocolError('NOT_FOUND');
    if (role.is_default === 1) throw new ProtocolError('BAD_REQUEST', '@everyone is implicit');
    wanted.set(id, role);
  }
  const current = new Map(core.repo.userRoles(p.userId).map((r) => [r.id, r]));
  const added = [...wanted.values()].filter((r) => !current.has(r.id));
  const removed = [...current.values()].filter((r) => !wanted.has(r.id));
  for (const role of [...added, ...removed]) {
    if (!canManageRole(actor, { position: Number(role.position) })) throw new ProtocolError('HIERARCHY');
  }
  // Giving a role grants its bits (spec §6: nobody grants a bit they do not have).
  for (const role of added) if (!canGrant(bits, Number(role.permissions))) throw new ProtocolError('FORBIDDEN');
  core.withVisibility(() => core.db.tx(() => {
    for (const role of removed) core.db.run('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', p.userId, role.id);
    for (const role of added) core.db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', p.userId, role.id);
  }));
  const member = core.repo.member(p.userId, core.isOnline(p.userId));
  core.broadcastAll({ t: 'member.updated', d: { member } });
  if (added.length > 0 || removed.length > 0) core.events.emit('access.changed', { userIds: [p.userId] });
  return { member };
};

export const roleHandlers: Record<string, Handler> = {
  'role.create': create,
  'role.update': update,
  'role.delete': remove,
  'role.reorder': reorder,
  'member.setRoles': setRoles,
};
