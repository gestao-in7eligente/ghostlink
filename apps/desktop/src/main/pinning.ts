import { X509Certificate, createHash } from 'node:crypto';
import type { Session } from 'electron';

/** The one server whose certificate the renderer may trust (spec §4). */
export interface RendererPin {
  hostname: string;
  serverKeyId: string;
}

/** The two Session methods pinning needs (a fake in tests). */
export type PinSession = Pick<Session, 'setCertificateVerifyProc' | 'closeAllConnections'>;

/** Chromium verification results: 0 = trust, -2 = reject (net::ERR_FAILED), -3 = Chromium's own CA check. */
export type VerifyResult = 0 | -2 | -3;

/**
 * serverKeyId = base64url(SHA-256(SPKI DER)) — never the raw EC point (`pubkey`)
 * nor the whole-certificate hash (`fingerprint256`) (spec §3.2).
 * Accepts DER bytes or PEM text.
 */
export function serverKeyIdFromCertificate(certificate: Uint8Array | string): string {
  const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url');
}

function bareHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/**
 * The decision behind setCertificateVerifyProc (spec §4): the pinned hostname is
 * trusted only with the pinned key (never falling back to CA validation); any other
 * hostname gets Chromium's normal verification. The API does not tell the port,
 * which is why only the currently connected server is ever pinned.
 */
export function verifyWithPin(pin: RendererPin | null, hostname: string, certificatePem: string): VerifyResult {
  if (pin === null || bareHost(hostname) !== bareHost(pin.hostname)) return -3;
  let keyId: string | null;
  try {
    keyId = serverKeyIdFromCertificate(certificatePem);
  } catch {
    keyId = null;
  }
  return keyId === pin.serverKeyId ? 0 : -2;
}

let active: { session: PinSession; pin: RendererPin | null } | null = null;

/** Installs the verify proc on the session (after app ready). Starts with no pin. */
export function installRendererPinning(session: PinSession): void {
  const state = { session, pin: null as RendererPin | null };
  active = state;
  session.setCertificateVerifyProc((request, callback) => {
    callback(verifyWithPin(state.pin, request.hostname, request.certificate.data));
  });
}

/**
 * Pins the connected server for the renderer (after `welcome`) or clears the pin
 * (on disconnect or server switch). Existing connections are closed on every
 * change so nothing keeps talking under the previous decision (spec §4); the
 * `CacheCertVerification` feature is disabled at startup for the same reason.
 */
export async function setRendererPin(pin: RendererPin | null): Promise<void> {
  if (active === null) throw new Error('installRendererPinning() must run first');
  active.pin = pin === null ? null : { hostname: pin.hostname, serverKeyId: pin.serverKeyId };
  await active.session.closeAllConnections();
}
