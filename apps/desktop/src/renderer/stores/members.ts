// The `members` store (spec §11.2): who is in the server, their roles and presence.
import type { Member, Role } from '@ghostlink/shared';
import { memberRoles } from './server.js';
import type { MembersState, TextAction } from './textState.js';

export const initialMembers: MembersState = { byId: {} };

/** Pure reducer of the members slice. */
export function membersSlice(s: MembersState, a: TextAction): MembersState {
  if (a.type === 'reset') {
    return { byId: Object.fromEntries(a.snapshot.text.members.map((m) => [m.userId, m])) };
  }
  if (a.type !== 'event') return s;
  const e = a.event;
  switch (e.t) {
    case 'member.joined':
    case 'member.updated':
      return { byId: { ...s.byId, [e.member.userId]: e.member } };
    case 'member.left': {
      if (!Object.hasOwn(s.byId, e.userId)) return s;
      const byId = { ...s.byId };
      delete byId[e.userId];
      return { byId };
    }
    case 'presence': {
      const member = Object.hasOwn(s.byId, e.userId) ? s.byId[e.userId] : undefined;
      if (!member || member.online === e.online) return s;
      return { byId: { ...s.byId, [e.userId]: { ...member, online: e.online } } };
    }
    case 'role.deleted': {
      // The server drops user_roles with the role (ON DELETE CASCADE) without a member.updated per member.
      let changed = false;
      const byId: Record<string, Member> = {};
      for (const [id, m] of Object.entries(s.byId)) {
        if (m.roleIds.includes(e.id)) {
          changed = true;
          byId[id] = { ...m, roleIds: m.roleIds.filter((r) => r !== e.id) };
        } else {
          byId[id] = m;
        }
      }
      return changed ? { byId } : s;
    }
    default:
      return s;
  }
}

// ---- selectors ----

export interface MemberGroup {
  /** `role:<id>`, `online` or `offline`. */
  key: string;
  kind: 'role' | 'online' | 'offline';
  role: Role | null;
  members: Member[];
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function byNickname(a: Member, b: Member): number {
  return collator.compare(a.nickname, b.nickname) || a.userId.localeCompare(b.userId);
}

/**
 * The member list (spec §11.1 item 4): online members grouped by their strongest
 * hoisted role (strongest role first), then the other online members, then everyone
 * offline. Empty groups are left out.
 */
export function groupMembers(members: Readonly<Record<string, Member>>, roles: Readonly<Record<string, Role>>): MemberGroup[] {
  const byRole = new Map<string, Member[]>();
  const online: Member[] = [];
  const offline: Member[] = [];
  for (const m of Object.values(members)) {
    if (!m.online) {
      offline.push(m);
      continue;
    }
    const hoisted = memberRoles(roles, m.roleIds).find((r) => r.hoist);
    if (!hoisted) {
      online.push(m);
      continue;
    }
    const list = byRole.get(hoisted.id) ?? [];
    list.push(m);
    byRole.set(hoisted.id, list);
  }
  const groups: MemberGroup[] = [...byRole.entries()]
    .map(([id, list]) => ({ key: `role:${id}`, kind: 'role' as const, role: roles[id]!, members: list.sort(byNickname) }))
    .sort((a, b) => b.role!.position - a.role!.position);
  if (online.length > 0) groups.push({ key: 'online', kind: 'online', role: null, members: online.sort(byNickname) });
  if (offline.length > 0) groups.push({ key: 'offline', kind: 'offline', role: null, members: offline.sort(byNickname) });
  return groups;
}
