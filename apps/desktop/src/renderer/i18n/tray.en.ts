import type { tray as trayPt } from './tray.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const tray: Record<keyof typeof trayPt, string> = {
  'tray.open': 'Open GhostLink',
  'tray.quit': 'Quit GhostLink',
  'tray.notice': 'GhostLink is still running in the tray. To quit, use the icon near the clock.',

  'tray.settings.title': 'Window',
  'tray.settings.closeToTray': 'Keep in the tray when closed',
  'tray.settings.closeToTrayHint':
    'The X hides the window and GhostLink keeps running near the clock, calls included. To quit for good, use "Quit GhostLink" on the icon.',
};
