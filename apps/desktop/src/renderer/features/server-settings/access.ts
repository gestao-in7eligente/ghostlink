// Which server-settings tabs a user sees (spec §11.1 item 6). Only hides UI: the
// server checks every request again (spec §6).
import { PERMISSIONS, has, type Channel } from '@ghostlink/shared';

export type ServerSettingsTab =
  | 'overview'
  | 'channels'
  | 'roles'
  | 'members'
  | 'invites'
  | 'bans'
  | 'transfer';

export function settingsTabs(
  bits: number,
  isOwner: boolean,
): ServerSettingsTab[] {
  const tabs: ServerSettingsTab[] = [];
  if (has(bits, PERMISSIONS.MANAGE_SERVER)) tabs.push('overview');
  if (has(bits, PERMISSIONS.MANAGE_CHANNELS)) tabs.push('channels');
  if (has(bits, PERMISSIONS.MANAGE_ROLES)) tabs.push('roles');
  if (has(bits, PERMISSIONS.MANAGE_ROLES) || has(bits, PERMISSIONS.KICK_MEMBERS) || has(bits, PERMISSIONS.BAN_MEMBERS)) tabs.push('members');
  if (has(bits, PERMISSIONS.CREATE_INVITES) || has(bits, PERMISSIONS.MANAGE_SERVER)) tabs.push('invites');
  if (has(bits, PERMISSIONS.BAN_MEMBERS)) tabs.push('bans');
  if (isOwner) tabs.push('transfer');
  return tabs;
}

export function canOpenServerSettings(bits: number, isOwner: boolean): boolean {
  return settingsTabs(bits, isOwner).length > 0;
}

/**
 * The full channel order after moving one channel up or down among the channels
 * of its own type (the sidebar groups text and voice; positions are shared).
 */
export function moveChannel(all: readonly Channel[], id: string, delta: -1 | 1): string[] | null {
  const sorted = [...all].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const moving = sorted.find((c) => c.id === id);
  if (!moving) return null;
  const sameType = sorted.filter((c) => c.type === moving.type);
  const index = sameType.indexOf(moving);
  const target = index + delta;
  if (target < 0 || target >= sameType.length) return null;
  const reordered = [...sameType];
  [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
  let next = 0;
  return sorted.map((c) => (c.type === moving.type ? reordered[next++]!.id : c.id));
}

/** The manageable roles (strongest first) after moving `id` to where `beforeId` is. */
export function reorderedRoleIds(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || toIndex < 0 || toIndex >= ids.length || from === toIndex) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(toIndex, 0, id);
  return next;
}
