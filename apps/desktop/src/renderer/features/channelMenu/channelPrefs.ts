// A text channel's own choices on this computer (spec 2026-10-02-menu-do-canal §2), kept with the saved
// server in main's servers.json: "Silenciar canal" (with or without an end), "Config. de notificação"
// and "Fixe o Canal no Topo". Pure functions over the saved entry, so the tests load them.
import { DEFAULT_NOTIFY_MODE, type ChannelPrefs, type NotifyMode, type SavedServer } from '../../../shared/ipcTypes.js';

type SavedChoices = Pick<SavedServer, 'notify' | 'channels' | 'pinned'>;

const NONE: ChannelPrefs = {};

export function channelPrefsOf(saved: SavedChoices | null | undefined, channelId: string): ChannelPrefs {
  const channels = saved?.channels;
  return channels && Object.hasOwn(channels, channelId) ? channels[channelId]! : NONE;
}

/** Muted until I unmute it (null), or until a time still ahead; a mute whose time passed is over by itself. */
export function isChannelMuted(prefs: ChannelPrefs, now: number): boolean {
  return prefs.mutedUntil === null || (typeof prefs.mutedUntil === 'number' && prefs.mutedUntil > now);
}

/** The server's mode, the one "Padrão do servidor" follows. */
export function serverNotifyMode(saved: SavedChoices | null | undefined): NotifyMode {
  return saved?.notify ?? DEFAULT_NOTIFY_MODE;
}

/**
 * Which of this channel's messages raise a notification: nothing while it is muted, else its own
 * mode, else the server's (notifications spec §1, v0.4.2).
 */
export function effectiveNotifyMode(saved: SavedChoices | null | undefined, channelId: string, now: number): NotifyMode {
  const prefs = channelPrefsOf(saved, channelId);
  if (isChannelMuted(prefs, now)) return 'none';
  return prefs.notify ?? serverNotifyMode(saved);
}

/** When the next timed mute ends (to show the channel again at that moment), or null when none will. */
export function nextMuteEnd(saved: SavedChoices | null | undefined, now: number): number | null {
  let next: number | null = null;
  for (const prefs of Object.values(saved?.channels ?? {})) {
    const until = prefs.mutedUntil;
    if (typeof until === 'number' && until > now && (next === null || until < next)) next = until;
  }
  return next;
}

export function isChannelPinned(saved: SavedChoices | null | undefined, channelId: string): boolean {
  return saved?.pinned?.includes(channelId) === true;
}

/** The text channels in sidebar order, the pinned ones first in the order they were pinned. */
export function pinnedFirst<C extends { id: string }>(channels: readonly C[], pinned: readonly string[] | undefined): C[] {
  if (!pinned || pinned.length === 0) return [...channels];
  const byId = new Map(channels.map((c) => [c.id, c]));
  const top: C[] = [];
  for (const id of pinned) {
    const channel = byId.get(id);
    if (channel && !top.includes(channel)) top.push(channel);
  }
  return [...top, ...channels.filter((c) => !top.includes(c))];
}
