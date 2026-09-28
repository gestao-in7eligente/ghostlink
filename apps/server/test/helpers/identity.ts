import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface TestIdentity {
  seed: Uint8Array;
  publicKeyRaw: Uint8Array;
  publicKey: string; // base64url
  userId: string;
  sign(message: Uint8Array): Uint8Array;
}

/** Ed25519 identity from a 32-byte seed, built exactly like the desktop does (spec §3.2). */
export function makeIdentity(seed: Uint8Array = randomBytes(32)): TestIdentity {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKeyRaw = Buffer.from(jwk.x!, 'base64url');
  return {
    seed,
    publicKeyRaw,
    publicKey: jwk.x!,
    userId: createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 32),
    sign: (message) => sign(null, message, privateKey),
  };
}
