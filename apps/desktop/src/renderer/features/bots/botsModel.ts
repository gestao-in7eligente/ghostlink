// Bots in the app (bots spec §3): who is a bot, when the sidebar shows the BOTS section, which
// slash commands a channel offers, and what the bot's settings show (bot page spec). Pure, over
// the text stores' state.
import { PERMISSIONS, SITE_URL, has, permissionsFor, type Channel, type Member, type Role } from '@ghostlink/shared';
import type { Locale } from '../../../shared/ipcTypes.js';
import type { Translate } from '../../i18n/index.js';
import { byNickname } from '../../stores/members.js';
import { canActOnMember, manageableRoles, myPermissions, rolesByPosition, subjectOf } from '../../stores/server.js';
import type { BotsState, MembersState, ServerState } from '../../stores/textState.js';
import type { SlashCommand, SlashEntry } from './slashModel.js';

export function isBot<M extends Pick<Member, 'bot'>>(member: M | undefined): member is M {
  return member?.bot === true;
}

/**
 * The server's own bot (the Ghost DJ, v0.5.0): it has no connection code and cannot be deleted, so
 * its menu and settings leave those out. Older servers have none (no profile says so).
 */
export function isSystemBot(profiles: BotsState['profiles'], botId: string): boolean {
  return profiles !== null && Object.hasOwn(profiles, botId) && profiles[botId]!.system;
}

/** The site's guide to connecting a bot (the code in GHOSTLINK_BOT, the discord.js import swap). */
export function botsGuideUrl(locale: Locale): string {
  return locale === 'en' ? `${SITE_URL}en/bots` : `${SITE_URL}bots`;
}

/** The server's bots, by name. */
export function serverBots(members: Readonly<Record<string, Member>>): Member[] {
  return Object.values(members).filter(isBot).sort(byNickname);
}

/**
 * The BOTS section shows when the server has bots, or when the person can create one there
 * (MANAGE_SERVER on a server that takes bots); otherwise it is hidden.
 */
export function showBotsSection(opts: { bots: number; canManage: boolean; supported: boolean }): boolean {
  return opts.bots > 0 || (opts.canManage && opts.supported);
}

/** True when the bot sees the channel (its roles, like anyone's; the server checks again on invoke). */
export function botSeesChannel(state: { server: ServerState; members: MembersState }, botId: string, channel: Pick<Channel, 'private' | 'allowedRoleIds'>): boolean {
  if (!Object.hasOwn(state.members.byId, botId)) return false;
  return has(permissionsFor(subjectOf(state.server, state.members, botId), channel), PERMISSIONS.VIEW_CHANNEL);
}

/** The commands the "/" picker offers in a channel: those of the bots in the server that see it. */
export function channelCommands(
  state: { server: ServerState; members: MembersState },
  commands: Readonly<Record<string, readonly SlashCommand[]>>,
  channel: Pick<Channel, 'private' | 'allowedRoleIds'>,
): SlashEntry[] {
  const entries: SlashEntry[] = [];
  for (const [botId, list] of Object.entries(commands)) {
    if (list.length === 0) continue;
    const bot = Object.hasOwn(state.members.byId, botId) ? state.members.byId[botId] : undefined;
    if (!isBot(bot) || !botSeesChannel(state, botId, channel)) continue;
    for (const command of list) entries.push({ botId, botName: bot.nickname, botAvatar: bot.avatar, command });
  }
  return entries;
}

// ---- the bot's settings (bot page spec) ----

/** A member's name, or `fallback` for someone who is not a member (any more). */
export function nameOf(members: Readonly<Record<string, Member>>, userId: string | null, fallback: string): string {
  return userId !== null && Object.hasOwn(members, userId) ? members[userId]!.nickname : fallback;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AGO_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
];
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** "há 5 minutos", "ontem", "agora" ("5 minutes ago", "yesterday", "now"), in the app's language. */
export function timeAgo(at: number, now: number, locale: string): string {
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormats.set(locale, format);
  }
  // A clock a little ahead of this one still reads "now".
  const elapsed = Math.max(0, now - at);
  for (const [unit, ms] of AGO_UNITS) if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit);
  return format.format(0, 'second');
}

/**
 * The bot's connection, as its page and settings say it: "Online", "Visto por último há 5
 * minutos", "Nunca conectou" (`lastSeenAt` null), or just "Offline" when it is not known
 * (`undefined`: still loading, or a server without the bot's settings).
 */
export function seenText(t: Translate, online: boolean, lastSeenAt: number | null | undefined, now: number, locale: string): string {
  if (online) return t('layout.online');
  if (lastSeenAt === undefined) return t('members.statusOffline');
  if (lastSeenAt === null) return t('bots.settings.neverConnected');
  return t('bots.settings.lastSeen', { ago: timeAgo(lastSeenAt, now, locale) });
}

/**
 * Server events after which the bot's settings load again: the bot changed (name, photo, roles,
 * description, commands, presence), or something that decides where it sees and speaks (roles,
 * channels), or a reconnect.
 */
export function refreshesBotSettings(event: { t: string; d?: unknown }, botId: string): boolean {
  const d: Record<string, unknown> = typeof event.d === 'object' && event.d !== null ? (event.d as Record<string, unknown>) : {};
  switch (event.t) {
    case 'welcome':
    case 'role.updated':
    case 'role.deleted':
    case 'channel.created':
    case 'channel.updated':
    case 'channel.deleted':
      return true;
    case 'bot.updated':
    case 'commands.updated':
      return d.botId === botId;
    case 'presence':
      return d.userId === botId;
    case 'member.updated':
    case 'member.joined':
      return typeof d.member === 'object' && d.member !== null && (d.member as { userId?: unknown }).userId === botId;
    default:
      return false;
  }
}

/** One role in the bot's Permissions tab. */
export interface BotRoleChoice {
  role: Role;
  /** The bot has it. */
  checked: boolean;
  /** I may give or take it (MANAGE_ROLES, below my top role, and the bot below me). */
  editable: boolean;
}

/**
 * The roles the bot's Permissions tab lists, strongest first: the ones it has and the ones I may
 * give it. `@todos` is everyone's, so it is never listed.
 */
export function botRoleChoices(state: { server: ServerState; members: MembersState }, botId: string): BotRoleChoice[] {
  const bot = Object.hasOwn(state.members.byId, botId) ? state.members.byId[botId]! : undefined;
  if (!bot) return [];
  const mayEdit = has(myPermissions(state), PERMISSIONS.MANAGE_ROLES) && canActOnMember(state, botId);
  const editable = new Set(mayEdit ? manageableRoles(state).map((r) => r.id) : []);
  const held = new Set(bot.roleIds);
  return rolesByPosition(state.server.roles)
    .filter((r) => !r.isDefault && (held.has(r.id) || editable.has(r.id)))
    .map((role) => ({ role, checked: held.has(role.id), editable: editable.has(role.id) }));
}

/** The bot's roles with `roleId` given or taken (what member.setRoles gets). */
export function toggledRole(roleIds: readonly string[], roleId: string): string[] {
  return roleIds.includes(roleId) ? roleIds.filter((id) => id !== roleId) : [...roleIds, roleId];
}
