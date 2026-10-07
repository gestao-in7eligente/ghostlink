// Neutral registration helpers shared by every build: the registration-key format and checksum, the
// activation-code pattern, and the license service URL. Pure (shared has no node:crypto): a small SHA-256
// is inlined for the key checksum.
import { utf8 } from './encoding.js';

/**
 * Base URL of the license service. Railway's own domain for now; it may be replaced with the owner's own
 * domain later, since this URL is built into the client that validates a registration key.
 */
export const LICENSE_SERVICE_URL: string = 'https://licencas-production-d8fc.up.railway.app';

/** The download code's format: 24 random bytes in base64url. */
export const DOWNLOAD_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const isDownloadCode = (v: unknown): v is string => typeof v === 'string' && DOWNLOAD_CODE_PATTERN.test(v);

// ---- The registration key: GLE-AAAA-BBBB-CCCC-DDDD, Crockford base32; the last 4 symbols are a
// 20-bit checksum (first 20 bits of sha256("GLE" + the first 12 symbols)).

export const REGISTRATION_KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REGISTRATION_KEY_RE = /^GLE-([0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** A small pure SHA-256 (shared has no node:crypto); only the 15-byte key checksum uses it. */
function sha256(msg: Uint8Array): Uint8Array {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((msg.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (msg.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i]! + v) >>> 0; });
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

/** The 4 checksum symbols for the first 12 symbols of a key. */
export function registrationKeyChecksum(body12: string): string {
  const d = sha256(utf8(`GLE${body12}`));
  const bits = (d[0]! << 12) | (d[1]! << 4) | (d[2]! >> 4); // the first 20 bits
  let out = '';
  for (let i = 3; i >= 0; i--) out += REGISTRATION_KEY_ALPHABET[(bits >> (i * 5)) & 31]!;
  return out;
}

/** The key in its one form (`GLE-AAAA-BBBB-CCCC-DDDD`), or null when it is not a key or its checksum is wrong. */
export function normalizeRegistrationKey(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  const up = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!up.startsWith('GLE')) return null;
  // Crockford's map applies after the GLE prefix (its L is a letter there, not a 1).
  const s = 'GLE' + up.slice(3).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!REGISTRATION_KEY_RE.test(s)) return null;
  const body = s.slice(4).replace(/-/g, '');
  return registrationKeyChecksum(body.slice(0, 12)) === body.slice(12) ? s : null;
}
