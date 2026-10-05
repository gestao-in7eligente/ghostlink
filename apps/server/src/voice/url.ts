import { formatHostPort, parseHostPort } from '@ghostlink/shared';

/** A plain `host[:port]` as the Host header carries it: no user info, path, query or spaces. */
const HOST_HEADER = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * The `livekitUrl` of a voice.join answer (spec §8.2): `wss://` plus the host:port this
 * client connected to, taken from its WebSocket upgrade's Host header. The renderer pins
 * only the hostname its connection used (spec §4), so any other host would fail TLS.
 * A missing or malformed Host header falls back to `fallback` (a public address).
 */
export function livekitUrlFor(requestHost: string | undefined, fallback: string): string {
  if (requestHost && requestHost.length <= 262 && HOST_HEADER.test(requestHost)) {
    try {
      const { host, port } = parseHostPort(requestHost);
      const explicitPort = requestHost.startsWith('[') ? requestHost.includes(']:') : requestHost.includes(':');
      return `wss://${explicitPort ? formatHostPort(host, port) : host.includes(':') ? `[${host}]` : host}`;
    } catch {
      // not a valid host[:port]: use the fallback
    }
  }
  return `wss://${fallback}`;
}
