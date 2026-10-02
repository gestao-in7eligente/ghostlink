import { create } from 'zustand';
import type { FriendsTab } from './friendsModel.js';

/**
 * A tab of the Friends page asked for from outside it: a friend request's notification opens
 * "Pendentes". The page takes it when it shows (or at once, when it already does) and clears it.
 */
export const useFriendsTabRequest = create<{ tab: FriendsTab | null; request(tab: FriendsTab): void; clear(): void }>()((set) => ({
  tab: null,
  request: (tab) => set({ tab }),
  clear: () => set({ tab: null }),
}));
