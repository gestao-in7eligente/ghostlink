import { X509Certificate, createHash } from 'node:crypto';
import type { Session } from 'electron';

/** A server whose certificate the renderer may trust (spec §4): the one on screen, or the call's (chamada-continua §2). */
export interface RendererPin {
  hostname: string;
  serverKeyId: string;
}

/** Never more than the server on screen and the call's (chamada-continua §2). */
export const MAX_RENDERER_PINS = 2;

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
 * The decision behind setCertificateVerifyProc (spec §4): a pinned hostname is trusted
 * only with one of its pinned keys (never falling back to CA validation); any other
 * hostname gets Chromium's normal verification. The API does not tell the port, so two
 * servers on one host (both pinned) accept each other's key there: both are servers the
 * app is connected to right now.
 */
export function verifyWithPins(pins: readonly RendererPin[], hostname: string, certificatePem: string): VerifyResult {
  const host = bareHost(hostname);
  const keys = pins.filter((p) => bareHost(p.hostname) === host).map((p) => p.serverKeyId);
  if (keys.length === 0) return -3;
  let keyId: string | null;
  try {
    keyId = serverKeyIdFromCertificate(certificatePem);
  } catch {
    keyId = null;
  }
  return keyId !== null && keys.includes(keyId) ? 0 : -2;
}

/** The single-pin form of verifyWithPins (null: nothing pinned). */
export function verifyWithPin(pin: RendererPin | null, hostname: string, certificatePem: string): VerifyResult {
  return verifyWithPins(pin === null ? [] : [pin], hostname, certificatePem);
}

const pinKey = (p: RendererPin) => `${bareHost(p.hostname)} ${p.serverKeyId}`;

/** Copies, normalizes and de-duplicates; more than MAX_RENDERER_PINS is a bug, refused. */
export function normalizePins(pins: readonly RendererPin[]): RendererPin[] {
  const out = new Map<string, RendererPin>();
  for (const p of pins) out.set(pinKey(p), { hostname: bareHost(p.hostname), serverKeyId: p.serverKeyId });
  if (out.size > MAX_RENDERER_PINS) throw new Error(`at most ${MAX_RENDERER_PINS} renderer pins`);
  return [...out.values()];
}

/** Whether going from `before` to `after` takes trust away from some host and key (connections must then close). */
export function pinsWithdrawn(before: readonly RendererPin[], after: readonly RendererPin[]): boolean {
  const kept = new Set(after.map(pinKey));
  return before.some((p) => !kept.has(pinKey(p)));
}

let active: { session: PinSession; pins: RendererPin[] } | null = null;

/** Installs the verify proc on the session (after app ready). Starts with no pin. */
export function installRendererPinning(session: PinSession): void {
  const state = { session, pins: [] as RendererPin[] };
  active = state;
  session.setCertificateVerifyProc((request, callback) => {
    callback(verifyWithPins(state.pins, request.hostname, request.certificate.data));
  });
}

/**
 * The renderer's pins: the server on screen and the call's, when they differ (chamada-continua
 * §2); never more. They follow `welcome`s and are withdrawn on a switch or a disconnect.
 * Existing connections are closed whenever a pin is withdrawn, so nothing keeps talking
 * under a trust that is gone (spec §4); `CacheCertVerification` is disabled at startup for
 * the same reason. A pin that only joins the set closes nothing: what is open was verified
 * under rules that still hold, and the call's LiveKit signaling goes on undisturbed.
 */
export async function setRendererPins(pins: readonly RendererPin[]): Promise<void> {
  if (active === null) throw new Error('installRendererPinning() must run first');
  const next = normalizePins(pins);
  const withdrawn = pinsWithdrawn(active.pins, next);
  active.pins = next;
  if (withdrawn) await active.session.closeAllConnections();
}
