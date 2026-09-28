import { create } from 'zustand';
import type { Settings } from '../../shared/ipcTypes.js';

interface SettingsStore {
  /** null until the first `settings.get()` answer. */
  settings: Settings | null;
  setSettings(settings: Settings): void;
}

/** The renderer's copy of `<userData>/settings.json`; the main process stays the source of truth. */
export const useSettingsStore = create<SettingsStore>()((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}));
