// Who is who, for the voice UI: names, voice channels and my own permission bits.
// The default reads the Text track's welcome fields (channels, roles, members) leniently;
// the integrated layout can provide its live stores instead (provideVoiceDirectory).
import { permissionsFor, type RoleGrant } from '@ghostlink/shared';

export interface VoiceDirectory {
  displayName(userId: string): string;
  channelName(channelId: string): string | null;
  /** Voice channels this user can see, in display order (for "Move to"). */
  voiceChannels(): { id: string; name: string }[];
  /** My effective bits in a channel. Only hides buttons: the server decides (spec §6). */
  myPermissions(channelId: string): number;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  private: boolean;
  allowedRoleIds: string[];
}

interface RoleInfo extends RoleGrant {
  isDefault: boolean;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const strings = (x: unknown): string[] => list(x).filter((s): s is string => typeof s === 'string');

function channelsOf(w: Record<string, unknown>): ChannelInfo[] {
  const out: ChannelInfo[] = [];
  for (const c of list(w.channels)) {
    if (!isObject(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.type !== 'string') continue;
    out.push({ id: c.id, name: c.name, type: c.type, private: c.private === true, allowedRoleIds: strings(c.allowedRoleIds) });
  }
  return out;
}

function rolesOf(w: Record<string, unknown>): RoleInfo[] {
  const out: RoleInfo[] = [];
  for (const r of list(w.roles)) {
    if (!isObject(r) || typeof r.id !== 'string' || typeof r.permissions !== 'number' || typeof r.position !== 'number') continue;
    out.push({ id: r.id, permissions: r.permissions, position: r.position, isDefault: r.isDefault === true });
  }
  return out;
}

/** The default directory: Text's welcome fields, then names LiveKit reported, then a short id. */
export function directoryFromWelcome(welcome: unknown, livekitNames: Readonly<Record<string, string>>): VoiceDirectory {
  const w = isObject(welcome) ? welcome : {};
  const self = isObject(w.self) ? w.self : {};
  const selfId = typeof self.userId === 'string' ? self.userId : null;
  const channels = channelsOf(w);
  const roles = rolesOf(w);
  const nicknames = new Map<string, string>();
  const roleIdsOf = new Map<string, string[]>();
  for (const m of list(w.members)) {
    if (!isObject(m) || typeof m.userId !== 'string') continue;
    if (typeof m.nickname === 'string') nicknames.set(m.userId, m.nickname);
    roleIdsOf.set(m.userId, strings(m.roleIds));
  }
  if (selfId && typeof self.nickname === 'string' && !nicknames.has(selfId)) nicknames.set(selfId, self.nickname);

  return {
    displayName: (userId) =>
      nicknames.get(userId) ?? (Object.hasOwn(livekitNames, userId) ? livekitNames[userId]! : userId.slice(0, 8)),
    channelName: (channelId) => channels.find((c) => c.id === channelId)?.name ?? null,
    voiceChannels: () => channels.filter((c) => c.type === 'voice').map(({ id, name }) => ({ id, name })),
    myPermissions: (channelId) => {
      const isOwner = self.isOwner === true;
      const everyone = roles.find((r) => r.isDefault);
      if (!isOwner && !everyone) return 0; // no role data: fail closed
      const mine = new Set(selfId ? (roleIdsOf.get(selfId) ?? []) : []);
      const channel = channels.find((c) => c.id === channelId);
      return permissionsFor(
        { isOwner, everyone: everyone?.permissions ?? 0, roles: roles.filter((r) => !r.isDefault && mine.has(r.id)) },
        channel ? { private: channel.private, allowedRoleIds: channel.allowedRoleIds } : undefined,
      );
    },
  };
}
