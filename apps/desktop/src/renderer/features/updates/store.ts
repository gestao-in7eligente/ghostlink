import { create } from 'zustand';
import type { UpdateState, UpdatesApi } from '../../../shared/updates.js';

/** What the update banner shows, if anything. */
export type UpdateBannerModel = { kind: 'downloaded' | 'rejected'; version: string };

interface UpdateStore {
  /** null until main answers `updates.state()`. */
  state: UpdateState | null;
  /** The banner the person closed (`<status>:<version>`), so the same notice does not come back. */
  dismissed: string | null;
  setState(state: UpdateState): void;
  dismiss(): void;
}

const bannerKey = (state: UpdateState) => `${state.status}:${state.version ?? ''}`;

/** Only a downloaded update or a rejected one deserves a banner; a closed banner stays closed for that version. */
export function bannerFor(state: UpdateState | null, dismissed: string | null): UpdateBannerModel | null {
  if (state === null || (state.status !== 'downloaded' && state.status !== 'rejected')) return null;
  if (bannerKey(state) === dismissed) return null;
  return { kind: state.status, version: state.version ?? '?' };
}

/** The renderer's copy of the main-process updater state (main/updater.ts is the source of truth). */
export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  state: null,
  dismissed: null,
  setState: (state) => set({ state }),
  dismiss: () => {
    const { state } = get();
    if (state) set({ dismissed: bannerKey(state) });
  },
}));

/** Loads the current state and follows main's events. Returns the unsubscribe function. */
export function syncUpdates(api: UpdatesApi): () => void {
  const { setState } = useUpdateStore.getState();
  let alive = true;
  const off = api.onState((state) => setState(state));
  api.state().then(
    (state) => alive && setState(state),
    () => {}, // no updater state: nothing to show
  );
  return () => {
    alive = false;
    off();
  };
}
