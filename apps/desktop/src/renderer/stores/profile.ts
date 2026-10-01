import { useEffect } from 'react';
import { create } from 'zustand';
import type { AvatarInfo, ProfileApi } from '../../shared/profileTypes.js';

/** The preload API (typed without the DOM lib, so node-side tests can load this module). */
function profileApi(): ProfileApi {
  return (globalThis as unknown as { window: { ghostlink: { profile: ProfileApi } } }).window.ghostlink.profile;
}

/** `failed`: main did not answer; my avatar then shows what the server has. */
export type ProfileStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface ProfileStore {
  status: ProfileStatus;
  /** My photo (main is the source of truth), or null: initials. */
  avatar: AvatarInfo | null;
  /** Asks main once; a second call while one is running waits for it. */
  load(): Promise<void>;
  /** Stores a new photo (already cropped and encoded); main then sends it to the server. */
  set(bytes: Uint8Array): Promise<AvatarInfo>;
  /** Back to initials. */
  clear(): Promise<void>;
}

let loading: Promise<void> | null = null;
/** Bumped by every change, so a load answered after it does not bring the old photo back. */
let generation = 0;

/**
 * My profile photo (spec 2026-10-01-foto-de-perfil §2). My own avatar always shows from
 * here, so a change appears at once, before any server has it.
 */
export const useProfileStore = create<ProfileStore>()((set) => ({
  status: 'idle',
  avatar: null,
  load: () => {
    loading ??= (async () => {
      const asked = generation;
      set((s) => (s.status === 'ready' ? s : { status: 'loading' }));
      try {
        const avatar = await profileApi().avatar();
        if (asked === generation) set({ status: 'ready', avatar });
      } catch {
        if (asked === generation) set({ status: 'failed' });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  set: async (bytes) => {
    const avatar = await profileApi().setAvatar(bytes);
    generation++;
    set({ status: 'ready', avatar });
    return avatar;
  },
  clear: async () => {
    await profileApi().clearAvatar();
    generation++;
    set({ status: 'ready', avatar: null });
  },
}));

/** The photo to show for someone: mine from this store once it is loaded, anyone else's (or mine until then) from the server. */
export function avatarHashFor(self: boolean, memberHash: string | null | undefined, mine: Pick<ProfileStore, 'status' | 'avatar'>): string | null {
  if (self && mine.status === 'ready') return mine.avatar?.hash ?? null;
  return memberHash ?? null;
}

/** For an avatar of mine: loads the store the first time, and gives what it knows (undefined until loaded). */
export function useMyAvatar(enabled: boolean): Pick<ProfileStore, 'status' | 'avatar'> {
  const status = useProfileStore((s) => s.status);
  const avatar = useProfileStore((s) => s.avatar);
  useEffect(() => {
    if (enabled && useProfileStore.getState().status === 'idle') void useProfileStore.getState().load();
  }, [enabled]);
  return { status, avatar };
}
