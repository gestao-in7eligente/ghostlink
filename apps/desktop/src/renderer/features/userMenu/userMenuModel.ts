// Which items a person's menu shows (spec 2026-10-02-menu-do-usuario §2), in order, from plain
// facts about them and me. No React and no stores, so the tests load it. Items only hide what I
// lack: the server decides every action.
import { PERMISSIONS, has } from '@ghostlink/shared';

export type UserMenuEntry =
  | 'profile'
  | 'mention'
  /** Mine: "Silenciar" (my microphone) and "Desativar áudio" (my sound). */
  | 'selfMute'
  | 'selfDeafen'
  /** Someone else's: "Silenciar" for me only, and "Volume do usuário". */
  | 'localMute'
  | 'volume'
  | 'editServerProfile'
  | 'roles'
  | 'serverMute'
  | 'serverDeafen'
  | 'move'
  | 'disconnect'
  | 'kick'
  | 'ban'
  | 'copyId'
  | 'separator';

export interface UserMenuFacts {
  /** The person is me. */
  self: boolean;
  /** "Perfil" has a card to open here (not inside the server settings). */
  canOpenProfile: boolean;
  /** "Editar perfil por servidor" can open the user settings here. */
  canEditProfile: boolean;
  /** Their voice channel, when they are in a call of this server that I can see; else null. */
  voiceChannelId: string | null;
  /** My bits in the server (roles, kick, ban). */
  serverBits: number;
  /** My bits in their voice channel (0 when they are in none). */
  channelBits: number;
  /** I am above them in the hierarchy (never true for myself). */
  above: boolean;
  /** How many roles I may give or take. */
  manageableRoles: number;
  /** Voice channels I could move them to (ones I see, other than theirs). */
  moveTargets: number;
  /** The server takes voice.moderate `deafen` (welcome.features). */
  serverDeafen: boolean;
}

/**
 * The menu, top to bottom: Perfil, Mencionar | voice items (mine or theirs), Editar perfil por
 * servidor, Cargos › | voice moderation, Expulsar, Banir | Copiar ID do usuário.
 */
export function userMenuEntries(f: UserMenuFacts): UserMenuEntry[] {
  const P = PERMISSIONS;
  const inVoice = f.voiceChannelId !== null;
  const other = !f.self && f.above;

  const personal: UserMenuEntry[] = [];
  if (inVoice) personal.push(...(f.self ? (['selfMute', 'selfDeafen'] as const) : (['localMute', 'volume'] as const)));
  if (f.self && f.canEditProfile) personal.push('editServerProfile');
  if (other && has(f.serverBits, P.MANAGE_ROLES) && f.manageableRoles > 0) personal.push('roles');

  const moderation: UserMenuEntry[] = [];
  if (other && inVoice && has(f.channelBits, P.MUTE_MEMBERS)) {
    moderation.push('serverMute');
    if (f.serverDeafen) moderation.push('serverDeafen');
  }
  if (other && inVoice && has(f.channelBits, P.MOVE_MEMBERS)) {
    if (f.moveTargets > 0) moderation.push('move');
    moderation.push('disconnect');
  }
  if (other && has(f.serverBits, P.KICK_MEMBERS)) moderation.push('kick');
  if (other && has(f.serverBits, P.BAN_MEMBERS)) moderation.push('ban');

  const entries: UserMenuEntry[] = f.canOpenProfile ? ['profile', 'mention'] : ['mention'];
  for (const group of [personal, moderation]) if (group.length > 0) entries.push('separator', ...group);
  entries.push('separator', 'copyId');
  return entries;
}
