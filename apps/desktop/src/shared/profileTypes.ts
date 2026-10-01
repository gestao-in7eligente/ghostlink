// The profile photo (spec 2026-10-01-foto-de-perfil-design.md): one per person, kept by main,
// sent to every server that announces `avatars`. Shared by main, preload and renderer.

/** The photo as main stores it: already cropped to 256×256 by the renderer. */
export interface AvatarInfo {
  /** SHA-256 of the bytes, lower-case hex: the photo's address everywhere. */
  hash: string;
  mime: 'image/webp' | 'image/gif';
}

/** window.ghostlink.profile. */
export interface ProfileApi {
  /** My photo, or null (initials). */
  avatar(): Promise<AvatarInfo | null>;
  /** Stores a new photo (WebP or GIF, 256×256, up to 2 MB) and sends it to the connected server. BAD_REQUEST otherwise. */
  setAvatar(bytes: Uint8Array): Promise<AvatarInfo>;
  /** Back to initials, here and on the connected server. */
  clearAvatar(): Promise<null>;
  /**
   * The icon of a connected server (MANAGE_SERVER; spec 2026-10-01-icone-do-servidor), with the
   * photo's checks. Resolves once the server holds it; `server.updated` then tells everyone.
   * `server.iconClear` (a plain request) takes it away.
   */
  setServerIcon(serverId: string, bytes: Uint8Array): Promise<AvatarInfo>;
}

/** Where the renderer loads any photo from; main's app:// handler serves it from the cache or fetches it (spec §3). */
export const AVATAR_URL_PREFIX = 'app://ghostlink/_avatar/';

export function avatarUrl(hash: string): string {
  return `${AVATAR_URL_PREFIX}${hash}`;
}
