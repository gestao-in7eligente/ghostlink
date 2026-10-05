/**
 * TLS pinned by the server's key (spec §3.2, §3.3), as the desktop app connects.
 *
 * COPIED from apps/desktop/src/main/pinning.ts (serverKeyIdFromCertificate) and
 * apps/desktop/src/main/connection.ts (pinnedTlsConnect, peerServerKeyId, tlsHost): the desktop
 * keeps them in its Electron main process, which this package cannot import. Keep the copies in
 * step; test/pingBot.test.ts checks this copy against a real server (right pin and wrong pin).
 */
import { X509Certificate, createHash } from 'node:crypto';
import type { ClientRequestArgs } from 'node:http';
import { isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';

/**
 * serverKeyId = base64url(SHA-256(SPKI DER)) — never the raw EC point (`pubkey`)
 * nor the whole-certificate hash (`fingerprint256`) (spec §3.2).
 * Accepts DER bytes or PEM text.
 * @internal
 */
export function serverKeyIdFromCertificate(certificate: Uint8Array | string): string {
  const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url');
}

/**
 * Reads the peer's serverKeyId right after the TLS handshake. getPeerCertificate(true)
 * is called exactly once: repeated getPeerX509Certificate() calls empty the chain (spec §3.3).
 */
function peerServerKeyId(socket: TLSSocket): string | null {
  const raw = socket.getPeerCertificate(true)?.raw;
  if (!raw) return null;
  try {
    return serverKeyIdFromCertificate(raw);
  } catch {
    return null;
  }
}

function tlsHost(host: string): { host: string; servername: string | undefined } {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // SNI only for DNS names; an IP as servername is invalid (RFC 6066).
  return { host: bare, servername: isIP(bare) === 0 ? bare : undefined };
}

/**
 * The `createConnection` hook given to ws: TLS without CA validation, then the
 * pin check on 'secureConnect' — before ws writes the HTTP upgrade request, so a
 * server with the wrong key never receives a single HTTP byte (spec §3.3), nor the bot's token.
 * Node never calls checkServerIdentity for a self-signed certificate, so it cannot hold the pin.
 * @internal
 */
export function pinnedTlsConnect(options: ClientRequestArgs, pin: string): TLSSocket {
  const { host, servername } = tlsHost(String(options.host ?? ''));
  const socket = tlsConnect({
    ...(options as ConnectionOptions),
    host,
    path: undefined, // a `path` option would make tls.connect open an IPC pipe
    servername,
    rejectUnauthorized: false,
  });
  socket.once('secureConnect', () => {
    if (peerServerKeyId(socket) !== pin) {
      socket.destroy(Object.assign(new Error('PIN_MISMATCH'), { code: 'PIN_MISMATCH' }));
    }
  });
  return socket;
}
