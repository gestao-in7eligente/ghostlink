// What a ghostlink://channel/… link in a message shows (Discord's channel links): "#name" for a channel of
// the server on screen that I can see, "<server> › #canal" for another server of my list, and a plain
// "#canal desconhecido" otherwise. Pure, so the tests load it; the click goes through openChannelLink.ts.
import type { Channel } from '@ghostlink/shared';
import type { SavedServer } from '../../../shared/ipcTypes.js';

export type ChannelChip =
  /** A channel of the server on screen that I see: clicking selects it. */
  | { kind: 'here'; name: string }
  /** Another server of my list (its channels' names are not known here): clicking opens it there. */
  | { kind: 'elsewhere'; server: string }
  /** Not a server of mine, or a channel I cannot see (or gone): not clickable. */
  | { kind: 'unknown' };

export interface ChannelChipFacts {
  /** The server on screen: its key and the channels I see; null on the Home screen. */
  onScreen: { serverKeyId: string; channels: Readonly<Record<string, Channel>> } | null;
  saved: readonly Pick<SavedServer, 'serverKeyId' | 'name'>[];
}

export function channelChip(serverKeyId: string, channelId: string, f: ChannelChipFacts): ChannelChip {
  if (f.onScreen !== null && f.onScreen.serverKeyId === serverKeyId) {
    const channel = Object.hasOwn(f.onScreen.channels, channelId) ? f.onScreen.channels[channelId]! : null;
    return channel !== null && channel.type === 'text' ? { kind: 'here', name: channel.name } : { kind: 'unknown' };
  }
  const server = f.saved.find((s) => s.serverKeyId === serverKeyId);
  return server ? { kind: 'elsewhere', server: server.name } : { kind: 'unknown' };
}
