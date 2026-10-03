// Which items a text channel's menu shows (spec 2026-10-02-menu-do-canal §2), in order, from plain facts
// about the channel and me. No React and no stores, so the tests load it. Items only hide what I lack:
// the server decides every action.
import {
  CHAT_LIMITS,
  formatInviteLink,
  formatPasteCode,
  formatWebLink,
  parseJoinInput,
  type InviteLinks,
} from '@ghostlink/shared';

export type ChannelMenuEntry =
  | 'markRead'
  | 'invite'
  | 'pin'
  | 'unpin'
  | 'copyLink'
  /** "Silenciar canal ›", or "Reativar canal" while it is muted. */
  | 'mute'
  | 'unmute'
  | 'notify'
  | 'editSite'
  | 'removeSite'
  | 'edit'
  | 'duplicate'
  | 'createText'
  | 'delete'
  | 'copyId'
  | 'separator';

export interface ChannelMenuFacts {
  /** The channel has messages past my read mark. */
  unread: boolean;
  /** CREATE_INVITES in the server. */
  canInvite: boolean;
  /** MANAGE_CHANNELS in the server. */
  canManageChannels: boolean;
  /** Pinned to the top of my list. */
  pinned: boolean;
  /** Muted now (a timed mute that ended is not). */
  muted: boolean;
  /** A site's channel and I manage sites (v0.7.0): "Editar site", "Remover site". */
  manageSite?: boolean;
}

export interface ChannelMenuModel {
  entries: ChannelMenuEntry[];
  /** Shown but greyed out: "Marcar como lida" with nothing new. */
  disabled: ReadonlySet<ChannelMenuEntry>;
}

/**
 * The menu, top to bottom: Marcar como lida | Convite para o canal, Fixar/Desafixar, Copiar link |
 * Silenciar/Reativar, Config. de notificação | Editar site, Remover site | Editar, Duplicar, Criar canal de texto, Excluir |
 * Copiar ID do canal.
 */
export function channelMenuEntries(f: ChannelMenuFacts): ChannelMenuModel {
  const entries: ChannelMenuEntry[] = ['markRead', 'separator'];
  if (f.canInvite) entries.push('invite');
  entries.push(f.pinned ? 'unpin' : 'pin', 'copyLink');
  entries.push('separator', f.muted ? 'unmute' : 'mute', 'notify');
  if (f.manageSite) entries.push('separator', 'editSite', 'removeSite');
  if (f.canManageChannels) entries.push('separator', 'edit', 'duplicate', 'createText', 'delete');
  entries.push('separator', 'copyId');
  return { entries, disabled: new Set<ChannelMenuEntry>(f.unread ? [] : ['markRead']) };
}

/** "Silenciar canal ›": for 15 min, 1 h, 3 h, 8 h, 24 h, or until I unmute it (null). */
export const MUTE_MINUTES = [15, 60, 180, 480, 1440, null] as const;
export type MuteChoice = (typeof MUTE_MINUTES)[number];

/** When a mute chosen now ends: a time (ms epoch), or null for "Até eu reativar". */
export function muteEnd(minutes: MuteChoice, now: number): number | null {
  return minutes === null ? null : now + minutes * 60_000;
}

/** "Duplicar canal": the name with the suffix ("-copia"), cut to fit the channel name limit. */
export function duplicateName(name: string, suffix: string, max: number = CHAT_LIMITS.channelNameMax): string {
  const room = Math.max(0, max - suffix.length);
  let base = '';
  for (const char of name) {
    if (base.length + char.length > room) break;
    base += char;
  }
  return `${base}${suffix}`;
}

/**
 * "Convite para o canal": the server's fresh invite with the channel added to all three forms, so
 * whoever joins through it lands there (when they can see it). The server makes the links; this
 * re-encodes them with the same rules. Should that fail (too long), the plain invite stays.
 */
export function inviteLinksWithChannel(links: InviteLinks, channelId: string): InviteLinks {
  try {
    const parsed = parseJoinInput(links.pasteCode);
    const web = links.webLink.indexOf('/j/#');
    if (parsed.kind !== 'invite' || web <= 0) return links;
    const invite = { ...parsed.invite, channelId };
    return {
      code: links.code,
      link: formatInviteLink(invite),
      pasteCode: formatPasteCode(invite),
      webLink: formatWebLink(invite, links.webLink.slice(0, web)),
    };
  } catch {
    return links;
  }
}
