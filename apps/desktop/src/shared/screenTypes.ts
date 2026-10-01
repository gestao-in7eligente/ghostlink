// Screen sharing (spec 2026-10-01-transmitir-tela-design.md): the renderer shows our own picker
// with the sources main lists, tells main which one was chosen, then asks LiveKit to capture;
// main's display-media handler hands over exactly that source. Shared by main, preload and renderer.

export type ScreenSourceKind = 'screen' | 'window';

export interface ScreenSource {
  /** desktopCapturer's id: "screen:<n>:<n>" or "window:<n>:<n>". */
  id: string;
  name: string;
  kind: ScreenSourceKind;
  /** A 320×180 PNG as a data URL; null when Windows gave an empty one (show the icon). */
  thumbnail: string | null;
  /** The window's icon as a PNG data URL; null for screens and windows without one. */
  icon: string | null;
}

export interface ScreenChoice {
  sourceId: string;
  /** Capture the PC's sound too (spec §4); main answers with 'loopback' only then. */
  audio: boolean;
}

/** What a desktopCapturer id looks like. */
export const SCREEN_SOURCE_ID = /^(screen|window):\d+:\d+$/;

/** A choice waits this long for the capture request, then is forgotten (spec §3). */
export const SCREEN_CHOICE_TTL_MS = 10_000;

/** window.ghostlink.screen. */
export interface ScreenApi {
  /** Screens and windows to pick from, with thumbnails (takes up to a few seconds on Windows). */
  sources(): Promise<ScreenSource[]>;
  /** Remembers the choice for the next capture request (10 s). */
  choose(choice: ScreenChoice): Promise<void>;
}
