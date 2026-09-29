/**
 * Permission model (spec §6). Pure functions shared by the server (source of
 * truth) and the UI (only to hide buttons).
 *
 * Bit positions are FIXED: they are stored in roles.permissions and must never
 * be renumbered. New permissions take the next free bit (18, 19, …) and every
 * value stays below 2^31, so plain 32-bit bit operations are safe.
 *
 * | bit | name             | bit | name             |
 * |-----|------------------|-----|------------------|
 * |   0 | VIEW_CHANNEL     |   9 | MANAGE_MESSAGES  |
 * |   1 | SEND_MESSAGES    |  10 | MANAGE_CHANNELS  |
 * |   2 | ADD_REACTIONS    |  11 | MANAGE_ROLES     |
 * |   3 | ATTACH_FILES     |  12 | MANAGE_SERVER    |
 * |   4 | MENTION_EVERYONE |  13 | KICK_MEMBERS     |
 * |   5 | CREATE_INVITES   |  14 | BAN_MEMBERS      |
 * |   6 | CONNECT_VOICE    |  15 | MUTE_MEMBERS     |
 * |   7 | SPEAK            |  16 | MOVE_MEMBERS     |
 * |   8 | VIDEO            |  17 | ADMINISTRATOR    |
 */
export const PERMISSIONS = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ADD_REACTIONS: 1 << 2,
  ATTACH_FILES: 1 << 3,
  MENTION_EVERYONE: 1 << 4,
  CREATE_INVITES: 1 << 5,
  CONNECT_VOICE: 1 << 6,
  SPEAK: 1 << 7,
  VIDEO: 1 << 8, // camera and screen share
  MANAGE_MESSAGES: 1 << 9,
  MANAGE_CHANNELS: 1 << 10,
  MANAGE_ROLES: 1 << 11,
  MANAGE_SERVER: 1 << 12,
  KICK_MEMBERS: 1 << 13,
  BAN_MEMBERS: 1 << 14,
  MUTE_MEMBERS: 1 << 15,
  MOVE_MEMBERS: 1 << 16,
  ADMINISTRATOR: 1 << 17,
} as const;

export type PermissionName = keyof typeof PERMISSIONS;

/** Names in bit order (bit 0 first). */
export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as readonly PermissionName[];

export const ALL_PERMISSIONS: number = Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0);

/** `@everyone` on a new server. No CREATE_INVITES: the owner turns it on in Roles (spec §6). */
export const DEFAULT_EVERYONE_PERMISSIONS: number =
  PERMISSIONS.VIEW_CHANNEL
  | PERMISSIONS.SEND_MESSAGES
  | PERMISSIONS.ADD_REACTIONS
  | PERMISSIONS.ATTACH_FILES
  | PERMISSIONS.CONNECT_VOICE
  | PERMISSIONS.SPEAK
  | PERMISSIONS.VIDEO;

/** `@everyone` always sits at position 0; every other role uses a position >= 1. */
export const EVERYONE_POSITION = 0;

export interface RoleGrant {
  id: string;
  permissions: number;
  position: number;
}

export interface PermissionSubject {
  isOwner: boolean;
  /** The `@everyone` role bits. */
  everyone: number;
  /** The member's other roles (never `@everyone`). */
  roles: readonly RoleGrant[];
}

export interface ChannelAccess {
  private: boolean;
  /** Roles that may see a private channel. `@everyone`'s id here grants nothing: reject it on input. */
  allowedRoleIds: readonly string[];
}

export interface HierarchySubject {
  isOwner: boolean;
  roles: readonly { position: number }[];
}

export type VoiceSource = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio';

/** True for a non-negative integer made only of known permission bits. Use it to validate input. */
export function isPermissionBits(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= ALL_PERMISSIONS && (x & ~ALL_PERMISSIONS) === 0;
}

/** Stored bits → known bits. Anything out of range counts as no permission (fail closed). */
function knownBits(x: number): number {
  return Number.isInteger(x) && x >= 0 && x < 2 ** 31 ? x & ALL_PERMISSIONS : 0;
}

/** True when `bits` contains every bit of `flag`. Pass the result of permissionsFor(). */
export function has(bits: number, flag: number): boolean {
  return (bits & flag) === flag;
}

/**
 * Effective permissions (spec §6): the owner has everything; everyone else gets
 * `@everyone` OR their roles, and ADMINISTRATOR implies every bit. With a channel,
 * the result is what the member may do inside it: a private channel the member
 * cannot see (no listed role, not ADMINISTRATOR, not the owner) yields 0.
 * VIEW_CHANNEL from a role alone is not enough for a private channel.
 */
export function permissionsFor(user: PermissionSubject, channel?: ChannelAccess): number {
  if (user.isOwner) return ALL_PERMISSIONS;
  let bits = knownBits(user.everyone);
  for (const role of user.roles) bits |= knownBits(role.permissions);
  if (has(bits, PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSIONS;
  if (channel?.private) {
    const allowed = new Set(channel.allowedRoleIds);
    if (!user.roles.some((role) => allowed.has(role.id))) return 0;
  }
  return bits;
}

/** Highest role position; EVERYONE_POSITION for a member with no other role. */
export function topPosition(roles: readonly { position: number }[]): number {
  let top = EVERYONE_POSITION;
  for (const role of roles) if (role.position > top) top = role.position;
  return top;
}

/**
 * Hierarchy (spec §6): acts only on a member whose top role is strictly below the
 * actor's. The owner is above everyone; nobody (the owner included) acts on the
 * owner, and nobody acts on themselves. ADMINISTRATOR does not bypass this.
 */
export function canActOn(actor: HierarchySubject, target: HierarchySubject): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner) return true;
  return topPosition(actor.roles) > topPosition(target.roles);
}

/** Roles are managed (edited, deleted, assigned, reordered) only when strictly below the actor's top role. */
export function canManageRole(actor: HierarchySubject, role: { position: number }): boolean {
  return actor.isOwner || role.position < topPosition(actor.roles);
}

/**
 * Nobody grants a bit they do not have. `actorBits` are the actor's effective
 * permissions (so ADMINISTRATOR and the owner may grant anything). When editing an
 * existing role, pass its `currentBits`: only the bits being added are checked.
 */
export function canGrant(actorBits: number, requestedBits: number, currentBits = 0): boolean {
  if (!isPermissionBits(requestedBits)) return false;
  const added = requestedBits & ~knownBits(currentBits);
  return (added & ~knownBits(actorBits)) === 0;
}

/**
 * LiveKit `canPublishSources` by name (spec §6): the microphone needs SPEAK and no
 * server mute; camera and screen (with its audio) need VIDEO. The server maps the
 * names to TrackSource and must set canPublish = list.length > 0 (an empty list
 * with canPublish would mean "every source").
 */
export function voiceSourcesFor(bits: number, opts: { serverMuted: boolean }): VoiceSource[] {
  const sources: VoiceSource[] = [];
  if (has(bits, PERMISSIONS.SPEAK) && !opts.serverMuted) sources.push('microphone');
  if (has(bits, PERMISSIONS.VIDEO)) sources.push('camera', 'screen_share', 'screen_share_audio');
  return sources;
}
