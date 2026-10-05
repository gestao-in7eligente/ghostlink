// "Copiar link" of the channel menu (spec 2026-10-02-menu-do-canal §2): ghostlink://channel/<serverKeyId>/<channelId>.
// Opening it in the app goes to that saved server and selects the channel. It names a server and a channel,
// never an address or an invite: only someone who already joined that server can open it.
import type { ChannelLinkTarget } from './ipcTypes.js';

const PREFIX = 'ghostlink://channel/';
const SERVER_KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const CHANNEL_ID = /^[A-Z2-7]{26}$/;
/** The rest of the link: the server key id, the channel id and an optional trailing slash (Windows shells add one). */
const REST = /^([A-Za-z0-9_-]{43})\/([A-Z2-7]{26})\/?$/;

export function formatChannelLink(serverKeyId: string, channelId: string): string {
  if (!SERVER_KEY_ID.test(serverKeyId) || !CHANNEL_ID.test(channelId)) throw new Error('BAD_REQUEST');
  return `${PREFIX}${serverKeyId}/${channelId}`;
}

/** The server and channel of a ghostlink://channel/… link (the scheme and host in any case), or null. */
export function parseChannelLink(value: unknown): ChannelLinkTarget | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const s = value.trim();
  if (s.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null;
  const match = REST.exec(s.slice(PREFIX.length));
  return match ? { kind: 'channel', serverKeyId: match[1]!, channelId: match[2]! } : null;
}
