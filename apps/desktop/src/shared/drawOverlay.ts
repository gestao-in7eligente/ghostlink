// The pencil's overlay over the real shared screen (spec 2026-10-01-lapis-na-tela-design.md §4):
// the renderer feeds main the strokes on my own share (window.ghostlink.draw), and main relays
// them to a transparent, click-through window over that monitor. Only main and the overlay's
// preload import the channel names, so the main window's preload never shares a chunk with it.
import type { DrawPoint } from '@ghostlink/shared';

/** main → overlay page. */
export const DRAW_OVERLAY_CHANNELS = {
  stroke: 'drawOverlay:stroke',
} as const;

/** One batch of a stroke, with the author's color and name already resolved by the renderer. */
export interface OverlayStroke {
  /** Unique per author and stroke: `${userId}:${strokeId}`. */
  id: string;
  /** '#rrggbb' from the pencil palette. */
  color: string;
  /** The author's name, shown at the stroke's tip. */
  label: string;
  /** Frame coordinates, 0 to 1 (the whole monitor, or the shared window). */
  points: DrawPoint[];
  end: boolean;
}

/** window.ghostlink.draw. */
export interface DrawApi {
  /**
   * Opens the overlay over the monitor or the window being shared. false for a window off Windows
   * (or when the shared window is gone), an unknown monitor, or a system that cannot keep it out of
   * the capture.
   */
  overlayOpen(): Promise<boolean>;
  /** Draws a batch on the overlay (ignored while it is closed). */
  overlayStroke(stroke: OverlayStroke): Promise<void>;
  overlayClose(): Promise<void>;
}

/** window.ghostlinkDrawOverlay, exposed to the overlay page by its preload. */
export interface DrawOverlayPageApi {
  /** Called with every batch main relays. */
  onStroke(cb: (stroke: OverlayStroke) => void): void;
}
