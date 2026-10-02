// A channel to open once a server's welcome arrives (spec 2026-10-02-menu-do-canal §2): an invite made with
// "Convite para o canal", or a ghostlink://channel/… link of a saved server that is not on screen. The welcome
// (layout/useTextSync.ts) takes it; the select does nothing for a channel I cannot see.
import type { ChannelLinkTarget, SavedServer } from '../../../shared/ipcTypes.js';

/** A request older than this is stale: the connection it waited for is long over. */
const REQUEST_TTL_MS = 2 * 60_000;

let pending: { serverKeyId: string; channelId: string; at: number } | null = null;

/** What a channel link does with my saved servers and the server on screen (openChannelLink.ts). */
export type ChannelLinkPlan = { kind: 'unknown' } | { kind: 'select' } | { kind: 'open'; server: SavedServer };

export function channelLinkPlan(link: ChannelLinkTarget, saved: readonly SavedServer[], onScreenId: string | null): ChannelLinkPlan {
  const server = saved.find((s) => s.serverKeyId === link.serverKeyId);
  if (!server) return { kind: 'unknown' };
  return server.id === onScreenId ? { kind: 'select' } : { kind: 'open', server };
}

/** The next welcome of this server opens `channelId` (a newer request replaces an older one). */
export function requestChannel(serverKeyId: string, channelId: string, now = Date.now()): void {
  pending = { serverKeyId, channelId, at: now };
}

/** Forgets the request (the connection it waited for failed). */
export function cancelChannelRequest(): void {
  pending = null;
}

/** The channel waiting for this server's welcome, once: null when none, too old, or for another server. */
export function takeChannelRequest(serverKeyId: string, now = Date.now()): string | null {
  if (pending !== null && now - pending.at > REQUEST_TTL_MS) pending = null;
  if (pending === null || pending.serverKeyId !== serverKeyId) return null;
  const { channelId } = pending;
  pending = null;
  return channelId;
}
