// Keeps a canvas painted with a board's strokes: one animation frame per screen refresh while
// any stroke is visible (to run the fade), none when the board is empty. Shared by the app's
// canvases and the overlay over the real screen.
import type { Rect } from './geometry.js';
import { paintStrokes, type PaintStroke } from './paint.js';
import type { Stroke, StrokeStore } from './strokes.js';

export interface PainterOptions {
  canvas: HTMLCanvasElement;
  board: StrokeStore;
  /** Where the picture is, in CSS pixels of the canvas; null while nothing can be placed. */
  rect(): Rect | null;
  /** The author's color and name label; null skips the stroke. */
  style(stroke: Stroke): { color: string; label: string | null } | null;
}

export interface Painter {
  /** Something changed: paint on the next frame (and keep going while strokes fade). */
  kick(): void;
  dispose(): void;
}

export function createPainter(o: PainterOptions): Painter {
  let frame = 0;
  let disposed = false;
  let ink = '';
  let font = '';

  const draw = () => {
    frame = 0;
    if (disposed) return;
    const { canvas } = o;
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const visible = o.board.visible();
    const rect = o.rect();
    if (rect && visible.length > 0) {
      if (!ink) {
        // The label's ink and font are app tokens (styles/tokens.css), read once they apply.
        const css = getComputedStyle(document.documentElement);
        ink = css.getPropertyValue('--bg-tile-label').trim();
        font = css.getPropertyValue('--font').trim();
      }
      const strokes: PaintStroke[] = [];
      for (const { stroke, alpha } of visible) {
        const style = o.style(stroke);
        if (style) strokes.push({ points: stroke.points, color: style.color, label: style.label, alpha });
      }
      paintStrokes(ctx, strokes, { rect, scale, ink, font });
    }
    if (visible.length > 0) frame = requestAnimationFrame(draw);
  };

  return {
    kick() {
      if (!disposed && frame === 0) frame = requestAnimationFrame(draw);
    },
    dispose() {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
