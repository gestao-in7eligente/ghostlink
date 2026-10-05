import { create } from 'zustand';

/**
 * Bumped whenever the saved-server list changed outside the screen showing it (a leave, a delete,
 * a server erased by its owner), so the rail and the Home list read it again.
 */
export const useSavedListStore = create<{ revision: number; changed(): void }>()((set) => ({
  revision: 0,
  changed: () => set((s) => ({ revision: s.revision + 1 })),
}));
