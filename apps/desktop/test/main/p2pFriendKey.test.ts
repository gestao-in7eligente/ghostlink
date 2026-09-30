import { createHmac, randomBytes } from 'node:crypto';
import DHT from 'hyperdht';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { IdentityStore, deriveFriendSeed, deriveServerSeed } from '../../src/main/identity.js';
import { friendKeyFromSeed, keyFromText, keyToText, signInboxProof, verifyInboxProof } from '../../src/main/p2p/friendKey.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i);

/** RFC 5869 written out by hand, so a swapped salt/info in the implementation cannot go unnoticed. */
function rfc5869(ikm: Uint8Array, salt: string, info: string): Uint8Array {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest().subarray(0, 32);
}

describe('deriveFriendSeed (friends spec §2)', () => {
  it('matches the frozen vector: changing it changes every friend key and friend code', () => {
    expect(hex(deriveFriendSeed(MASTER))).toBe('36d148c367d7a2b2c1972f53e63cbe39ec3baacfd73f5994004e58cfc418338e');
    expect(hex(friendKeyFromSeed(deriveFriendSeed(MASTER)).publicKey)).toBe('18ecbc0cbc6c7cae30ed452c943d02bc9b5cb17735efaae799f8d6ef0f3a4472');
  });

  it('is HKDF-SHA256 with salt "ghostlink/friend/v1" and an empty info', () => {
    for (let i = 0; i < 5; i++) {
      const master = randomBytes(32);
      expect(hex(deriveFriendSeed(master))).toBe(hex(rfc5869(master, 'ghostlink/friend/v1', '')));
    }
  });

  it('is unrelated to every per-server seed, so servers cannot link a person through their friends', () => {
    const serverSeed = deriveServerSeed(MASTER, keyToText(new Uint8Array(32).fill(7)));
    expect(hex(deriveFriendSeed(MASTER))).not.toBe(hex(serverSeed));
  });

  it('rejects a master seed that is not 32 bytes', () => {
    expect(() => deriveFriendSeed(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe('IdentityStore.friendSeed', () => {
  const dir = useTempDir();

  it('hands out the friend seed only while the identity is ready', () => {
    const crypto = new FakeSafeStorage();
    const store = IdentityStore.load(dir.path, crypto);
    expect(() => store.friendSeed()).toThrow(AppError);
    store.create();
    const seed = store.friendSeed();
    expect(seed).toHaveLength(32);
    expect(hex(IdentityStore.load(dir.path, crypto).friendSeed())).toBe(hex(seed));
    expect(hex(seed)).toBe(hex(deriveFriendSeed(store.exportSeed())));
    store.deleteIdentity();
    expect(() => store.friendSeed()).toThrow(AppError);
  });
});

describe('the friend key (friends spec §2)', () => {
  it('is the very key Hyperswarm derives from the same seed', () => {
    for (let i = 0; i < 5; i++) {
      const seed = randomBytes(32);
      expect(hex(friendKeyFromSeed(seed).publicKey)).toBe(hex(DHT.keyPair(seed).publicKey));
    }
  });

  it('travels as base64url of 32 bytes, and nothing else decodes', () => {
    const key = friendKeyFromSeed(deriveFriendSeed(MASTER)).publicKey;
    const text = keyToText(key);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hex(keyFromText(text))).toBe(hex(key));
    for (const bad of ['', text.slice(1), `${text}A`, `${text.slice(0, 42)}=`, `${text.slice(0, 42)}+`, `${text.slice(0, 42)}B`]) {
      expect(() => keyFromText(bad), bad).toThrow(AppError);
    }
  });
});

describe('the inbox proof (friends spec §3.2)', () => {
  const owner = friendKeyFromSeed(randomBytes(32));
  const hash = randomBytes(64);

  it('verifies against the friend key and the handshake hash of that connection', () => {
    const sig = signInboxProof(owner, hash);
    expect(sig).toHaveLength(64);
    expect(verifyInboxProof(owner.publicKey, hash, sig)).toBe(true);
  });

  it('is refused for another connection, another key or a changed signature', () => {
    const sig = signInboxProof(owner, hash);
    expect(verifyInboxProof(owner.publicKey, randomBytes(64), sig)).toBe(false);
    expect(verifyInboxProof(friendKeyFromSeed(randomBytes(32)).publicKey, hash, sig)).toBe(false);
    expect(verifyInboxProof(owner.publicKey, hash, Uint8Array.from(sig, (b, i) => (i === 0 ? b ^ 1 : b)))).toBe(false);
    expect(verifyInboxProof(owner.publicKey, hash, sig.subarray(0, 63))).toBe(false);
    expect(verifyInboxProof(new Uint8Array(31), hash, sig)).toBe(false);
  });

  it('signs "ghostlink/inbox/v1\\n" ‖ handshakeHash, not the bare hash', () => {
    // A signature over the bare hash could be replayed from any other protocol that signs hashes.
    expect(verifyInboxProof(owner.publicKey, hash, owner.sign(hash))).toBe(false);
    expect(verifyInboxProof(owner.publicKey, hash, owner.sign(Buffer.concat([Buffer.from('ghostlink/inbox/v1\n'), hash])))).toBe(true);
  });
});
