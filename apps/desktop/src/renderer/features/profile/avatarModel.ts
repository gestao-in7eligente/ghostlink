// What an avatar circle shows (spec 2026-10-01-foto-de-perfil §6), pure so it is tested
// without a DOM: the photo when there is a hash, the person's initials otherwise.
import { AVATAR_HASH } from '@ghostlink/shared';
import { avatarUrl } from '../../../shared/profileTypes.js';
import { serverInitials } from '../../layout/names.js';

export type AvatarFace = { kind: 'image'; src: string } | { kind: 'initials'; text: string };

/** `failed` is the hash whose image did not load (main answered 404, or it did not decode). */
export function avatarFace(hash: string | null | undefined, failed: string | null, name: string): AvatarFace {
  if (hash && hash !== failed && AVATAR_HASH.test(hash)) return { kind: 'image', src: avatarUrl(hash) };
  return { kind: 'initials', text: serverInitials(name) };
}

/** The initials' size for a circle: 13 px at 32 px, like the Home rows. */
export function initialsFontSize(size: number): number {
  return Math.round(size * 0.4);
}
