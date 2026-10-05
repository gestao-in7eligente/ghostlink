// Lets the server screen's pieces open the user settings, which the main layout owns: a person's
// menu has "Editar perfil por servidor" (spec 2026-10-02-menu-do-usuario §2 item 4).
import { create } from 'zustand';

/** The main layout's "open the user settings (on Perfil)", or null while none is on screen. */
export const useUserSettingsOpener = create<{ open: (() => void) | null }>()(() => ({ open: null }));

/** Called by the main layout; returns the function that takes it back. */
export function provideUserSettingsOpener(open: () => void): () => void {
  useUserSettingsOpener.setState({ open });
  return () => {
    if (useUserSettingsOpener.getState().open === open) useUserSettingsOpener.setState({ open: null });
  };
}
