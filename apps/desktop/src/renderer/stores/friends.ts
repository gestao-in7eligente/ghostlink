// The friends snapshot as main last reported it (spec 2026-09-30 §8). Main owns the truth:
// every call returns the snapshot after the change, and events push what the network did.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { FriendsSnapshot } from '../../shared/friendsTypes.js';
import { newerSnapshot } from '../features/friends/friendsModel.js';
import { errorCodeOf } from '../i18n/index.js';

interface FriendsStore {
  /** null until the first answer. */
  snapshot: FriendsSnapshot | null;
  /** Why the first load failed. */
  loadError: AppErrorCode | null;
  apply(snapshot: FriendsSnapshot): void;
  load(): Promise<void>;
  /** Runs a friends call and applies the snapshot it returns; rejects with the call's error. */
  run(call: () => Promise<FriendsSnapshot>): Promise<void>;
}

export const useFriendsStore = create<FriendsStore>()((set, get) => ({
  snapshot: null,
  loadError: null,
  apply: (snapshot) => set({ snapshot: newerSnapshot(get().snapshot, snapshot), loadError: null }),
  load: async () => {
    try {
      get().apply(await window.ghostlink.friends.state());
    } catch (e) {
      set({ loadError: errorCodeOf(e) });
    }
  },
  run: async (call) => get().apply(await call()),
}));

/** Keeps the store in step with main while the Home screen is mounted. */
export function useFriendsSync(): void {
  useEffect(() => {
    const off = window.ghostlink.friends.onChange((snapshot) => useFriendsStore.getState().apply(snapshot));
    void useFriendsStore.getState().load();
    return off;
  }, []);
}
