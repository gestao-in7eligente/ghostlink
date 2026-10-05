// The update splash ("Atualizar ao abrir"): main (updateSplash.ts) → page the view to show,
// page → main "Open without updating". Only main and the splash preload import the channel
// names, so the main window's preload never shares a chunk with the splash one.
import type { Locale } from './ipcTypes.js';

export const SPLASH_CHANNELS = {
  view: 'splash:view',
  skip: 'splash:skip',
} as const;

/** Everything the page shows, already translated in main. */
export interface SplashView {
  lang: Locale;
  status: string;
  /** The progress bar, 0–100; null hides it. */
  percent: number | null;
  /** The "Open without updating" link, or null while it is hidden. */
  skip: string | null;
}

/** window.ghostlinkSplash, exposed by the splash preload. */
export interface SplashApi {
  /** Called with the latest view right away (when there is one) and on every change. */
  onView(cb: (view: SplashView) => void): void;
  skip(): void;
}
