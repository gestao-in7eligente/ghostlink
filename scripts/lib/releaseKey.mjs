// Ed25519 release-key helpers (spec §15) for gen-release-key.mjs and sign-release.mjs.
// Node built-ins only: the signing job installs no npm package while it holds the key.
//
// Format of a detached signature `<file>.ed25519`: the raw 64-byte Ed25519 signature over
// the file's bytes. Anyone can check it with openssl:
//   openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin -in FILE -sigfile FILE.ed25519
import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNATURE_SUFFIX = '.ed25519';
export const SIGNATURE_BYTES = 64;
/** RFC 8410 SPKI header of an Ed25519 public key; the raw 32-byte key follows it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * A fresh release keypair.
 * @returns {{ publicKey: string; privateKeyPem: string }} raw public key (base64url) and PKCS#8 PEM private key
 */
export function generateReleaseKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: rawPublicKey(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * The raw public key of an Ed25519 key object, base64url without padding (RELEASE_PUBLIC_KEY's format).
 * @param {import('node:crypto').KeyObject} key a public or private Ed25519 key
 */
export function rawPublicKey(key) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== SPKI_PREFIX.length + 32 || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new Error('not an Ed25519 public key');
  }
  return der.subarray(SPKI_PREFIX.length).toString('base64url');
}

/**
 * Strict: exactly 32 bytes in canonical base64url (Node's decoder alone would skip bad characters).
 * @param {string} raw
 */
export function publicKeyFromRaw(raw) {
  const bytes = Buffer.from(raw, 'base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw) || bytes.length !== 32 || bytes.toString('base64url') !== raw) {
    throw new Error('the release public key must be 32 bytes of canonical base64url');
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

/**
 * The public key as SPKI PEM, for `openssl pkeyutl -verify -pubin -inkey`.
 * @param {string} raw
 */
export function publicKeyPem(raw) {
  return publicKeyFromRaw(raw).export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Parses the PKCS#8 PEM from the release environment. Error messages never contain the key.
 * @param {string} pem
 */
export function loadPrivateKey(pem) {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('the release private key is not a valid PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release private key must be an Ed25519 key');
  return key;
}

/**
 * RELEASE_PUBLIC_KEY as written in packages/shared/src/release.ts (the key the updater trusts).
 * @param {string} repoRoot
 */
export function embeddedPublicKey(repoRoot) {
  const source = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'release.ts'), 'utf8');
  const match = /export const RELEASE_PUBLIC_KEY = '([A-Za-z0-9_-]{43})';/.exec(source);
  const key = match?.[1];
  if (key === undefined) throw new Error('RELEASE_PUBLIC_KEY not found in packages/shared/src/release.ts');
  return key;
}

/**
 * @param {Uint8Array} data
 * @param {Uint8Array} signature
 * @param {import('node:crypto').KeyObject} publicKey
 */
export function verifyBytes(data, signature, publicKey) {
  return signature.length === SIGNATURE_BYTES && verify(null, data, publicKey, signature);
}

/**
 * Writes `<file>.ed25519` next to each file. Existing `.ed25519` inputs are skipped. Refuses to
 * sign anything when the private key does not belong to `expectedPublicKey`: a release signed by
 * a key the app does not trust would never update anyone, so it must fail before publishing.
 * @param {string[]} files
 * @param {string} privateKeyPem
 * @param {string} expectedPublicKey raw base64url (RELEASE_PUBLIC_KEY)
 * @returns {string[]} the signature files written
 */
export function signFiles(files, privateKeyPem, expectedPublicKey) {
  const privateKey = loadPrivateKey(privateKeyPem);
  if (rawPublicKey(privateKey) !== expectedPublicKey) {
    throw new Error('the release private key does not match RELEASE_PUBLIC_KEY in packages/shared/src/release.ts');
  }
  const publicKey = publicKeyFromRaw(expectedPublicKey);
  const targets = files.filter((file) => !file.endsWith(SIGNATURE_SUFFIX));
  for (const file of targets) {
    if (!statSync(file).isFile()) throw new Error(`${file} is not a file`);
  }
  const written = [];
  for (const file of targets) {
    const data = readFileSync(file);
    const signature = sign(null, data, privateKey);
    if (!verifyBytes(data, signature, publicKey)) throw new Error(`self-check failed for ${file}`);
    writeFileSync(`${file}${SIGNATURE_SUFFIX}`, signature);
    written.push(`${file}${SIGNATURE_SUFFIX}`);
  }
  return written;
}
