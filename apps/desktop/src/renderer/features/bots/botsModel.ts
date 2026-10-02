// Bots in the app (bots spec §3): who is a bot, when the sidebar shows the BOTS section, and which
// slash commands a channel offers. Pure, over the text stores' state.
import { PERMISSIONS, SITE_URL, has, permissionsFor, type Channel, type Member } from '@ghostlink/shared';
import type { Locale } from '../../../shared/ipcTypes.js';
import { byNickname } from '../../stores/members.js';
import { subjectOf } from '../../stores/server.js';
import type { MembersState, ServerState } from '../../stores/textState.js';
import type { SlashCommand, SlashEntry } from './slashModel.js';

export function isBot<M extends Pick<Member, 'bot'>>(member: M | undefined): member is M {
  return member?.bot === true;
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
