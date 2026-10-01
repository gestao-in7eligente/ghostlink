// Conversations between friends (friends spec §4.1). A 1:1 conversation needs no setup: both
// computers compute the same id from the two friend keys, and only those two people write in it.
// Groups (phase 4) bring random ids and members who join and leave.
import { createHash } from 'node:crypto';
import { CRYPTO_LABELS, utf8 } from '@ghostlink/shared';
import { sameKey } from './friendKey.js';

/** What a conversation id looks like: 16 bytes in lowercase hex. */
export const CONVERSATION_ID = /^[0-9a-f]{32}$/;

/** The two keys, the smaller first (compared byte by byte). */
export function dmMembers(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  return Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
}

/** spec §4.1: hex(SHA-256("ghostlink/dm/v1" ‖ smaller key ‖ bigger key))[0:32]. */
export function dmConversationId(a: Uint8Array, b: Uint8Array): string {
  const [low, high] = dmMembers(a, b);
  return createHash('sha256').update(utf8(CRYPTO_LABELS.dm)).update(low).update(high).digest('hex').slice(0, 32);
}

/** Who may write in a conversation: its members, nobody else. */
export function isMember(members: readonly Uint8Array[], key: Uint8Array): boolean {
  return members.some((member) => sameKey(member, key));
}
