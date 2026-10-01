// Paints strokes on a 2D canvas (spec 2026-10-01-lapis-na-tela-design.md §3): a round line of
// ~4 px in the author's color, smoothed through the midpoints, and the author's name in a small
// label at the tip. Shared by the app's canvases and the overlay over the real screen.
import type { DrawPoint } from '@ghostlink/shared';
import { labelText } from './colors.js';
import { fromFrame, strokeWidth, type Rect } from './geometry.js';

export interface PaintStroke {
  points: readonly DrawPoint[];
  color: string;
  /** The author's name at the tip; null for none. */
  label: string | null;
  alpha: number;
}

export interface PaintOptions {
  /** Where the picture is, in CSS pixels of the canvas. */
  rect: Rect;
  /** Canvas pixels per CSS pixel (devicePixelRatio). */
  scale: number;
  /** The label's text color. */
  ink: string;
  /** The label's font family. */
  font: string;
}

export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: readonly PaintStroke[], o: PaintOptions): void {
  const width = strokeWidth(o.rect) * o.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const at = (p: DrawPoint) => {
      const { x, y } = fromFrame(p, o.rect);
      return { x: x * o.scale, y: y * o.scale };
    };
    ctx.globalAlpha = s.alpha;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = width;
    const first = at(s.points[0]!);
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Quadratic curves through the midpoints: smooth without lagging behind the pointer.
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < s.points.length - 1; i++) {
        const p = at(s.points[i]!);
        const q = at(s.points[i + 1]!);
        ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
      }
      const last = at(s.points[s.points.length - 1]!);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    if (s.label) paintLabel(ctx, s, at(s.points[s.points.length - 1]!), width, o);
  }
  ctx.globalAlpha = 1;
}

/** A small pill in the author's color just past the stroke's tip. */
function paintLabel(ctx: CanvasRenderingContext2D, s: PaintStroke, tip: { x: number; y: number }, lineWidth: number, o: PaintOptions): void {
  const text = labelText(s.label!);
  const size = 11 * o.scale;
  const padX = 5 * o.scale;
  const height = 16 * o.scale;
  ctx.font = `600 ${size}px ${o.font}`;
  const width = ctx.measureText(text).width + padX * 2;
  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;
  // Below and right of the tip; flipped when it would leave the canvas.
  let x = tip.x + lineWidth;
  let y = tip.y + lineWidth;
  if (x + width > canvasWidth) x = tip.x - lineWidth - width;
  if (y + height > canvasHeight) y = tip.y - lineWidth - height;
  ctx.fillStyle = s.color;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = o.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + height / 2);
}
