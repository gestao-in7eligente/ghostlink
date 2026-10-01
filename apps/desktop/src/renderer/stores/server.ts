// The `server` store (spec §11.2): name, join mode, owner, limits and roles.
import {
  canActOn,
  canManageRole,
  permissionsFor,
  type ChannelAccess,
  type HierarchySubject,
  type PermissionSubject,
  type Role,
} from '@ghostlink/shared';
import type { MembersState, ServerState, TextAction, TextState } from './textState.js';

export const initialServer: ServerState = {
  serverId: null,
  selfId: '',
  name: '',
  icon: null,
  joinMode: 'invite',
  version: '',
  ownerId: null,
  maxMembers: 0,
  hasPassword: false,
  roles: {},
};

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** Pure reducer of the server slice. */
export function serverSlice(s: ServerState, a: TextAction): ServerState {
  if (a.type === 'reset') {
    const { snapshot } = a;
    const settings = snapshot.text.serverSettings;
    return {
      serverId: snapshot.serverId,
      selfId: snapshot.self.userId,
      name: snapshot.server.name,
      icon: settings.icon,
      joinMode: snapshot.server.joinMode,
      version: snapshot.server.version,
      ownerId: settings.ownerId ?? (snapshot.self.isOwner ? snapshot.self.userId : null),
      maxMembers: settings.maxMembers,
      hasPassword: settings.hasPassword,
      roles: Object.fromEntries(snapshot.text.roles.map((r) => [r.id, r])),
    };
  }
  if (a.type !== 'event') return s;
  const e = a.event;
  switch (e.t) {
    case 'server.updated':
      return { ...s, ...e.server };
    case 'role.created':
    case 'role.updated':
      return { ...s, roles: { ...s.roles, [e.role.id]: e.role } };
    case 'role.deleted':
      return Object.hasOwn(s.roles, e.id) ? { ...s, roles: without(s.roles, e.id) } : s;
    default:
      return s;
  }
}

// ---- selectors ----

/** Roles strongest first; `@todos` (position 0) always last. */
export function rolesByPosition(roles: Readonly<Record<string, Role>>): Role[] {
  return Object.values(roles).sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}

export function everyoneRole(roles: Readonly<Record<string, Role>>): Role | undefined {
  return Object.values(roles).find((r) => r.isDefault);
}

/** A member's roles (never `@todos`), strongest first; unknown ids are skipped. */
export function memberRoles(roles: Readonly<Record<string, Role>>, roleIds: readonly string[]): Role[] {
  const list: Role[] = [];
  for (const id of roleIds) {
    const role = Object.hasOwn(roles, id) ? roles[id] : undefined;
    if (role && !role.isDefault) list.push(role);
  }
  return list.sort((a, b) => b.position - a.position);
}

/** The permission subject of any member, for the UI (the server stays the source of truth, spec §6). */
export function subjectOf(server: ServerState, members: MembersState, userId: string): PermissionSubject & HierarchySubject {
  const member = Object.hasOwn(members.byId, userId) ? members.byId[userId] : undefined;
  const roles = memberRoles(server.roles, member?.roleIds ?? []);
  return {
    isOwner: server.ownerId !== null && server.ownerId === userId,
    everyone: everyoneRole(server.roles)?.permissions ?? 0,
    roles: roles.map((r) => ({ id: r.id, permissions: r.permissions, position: r.position })),
  };
}

/** The current user's effective permissions, server-wide or inside a channel. */
export function myPermissions(state: Pick<TextState, 'server' | 'members'>, channel?: ChannelAccess): number {
  return permissionsFor(subjectOf(state.server, state.members, state.server.selfId), channel);
}

/** True when the current user may act on `userId` (kick, ban, roles): hierarchy only, not the permission bit. */
export function canActOnMember(state: Pick<TextState, 'server' | 'members'>, userId: string): boolean {
  if (userId === state.server.selfId) return false;
  return canActOn(subjectOf(state.server, state.members, state.server.selfId), subjectOf(state.server, state.members, userId));
}

/** Roles the current user may give or take (below their top role; never `@todos`). */
export function manageableRoles(state: Pick<TextState, 'server' | 'members'>): Role[] {
  const me = subjectOf(state.server, state.members, state.server.selfId);
  return rolesByPosition(state.server.roles).filter((r) => !r.isDefault && canManageRole(me, r));
}

export function isOwner(server: ServerState): boolean {
  return server.ownerId !== null && server.ownerId === server.selfId;
}
