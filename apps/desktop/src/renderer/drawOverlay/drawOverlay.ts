// The pencil's overlay page (main/drawOverlay.ts): paints the strokes main relays over the whole
// monitor, with the same fade as in the app. No React: it is a single canvas.
import './drawOverlay.css';
import type { DrawOverlayPageApi } from '../../shared/drawOverlay.js';
import { createPainter } from '../features/draw/painter.js';
import { StrokeStore } from '../features/draw/strokes.js';

const api = (window as Window & { ghostlinkDrawOverlay?: DrawOverlayPageApi }).ghostlinkDrawOverlay;
const canvas = document.getElementById('strokes') as HTMLCanvasElement;
const board = new StrokeStore();
/** Each stroke's color and name, as the app resolved them. */
const styles = new Map<string, { color: string; label: string }>();
let received = 0;

const painter = createPainter({
  canvas,
  board,
  // The window is the shared monitor: the frame fills it, without bars.
  rect: () => ({ x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight }),
  style: (stroke) => styles.get(stroke.key) ?? null,
});

api?.onStroke((stroke) => {
  styles.set(stroke.id, { color: stroke.color, label: stroke.label });
  board.apply({ key: stroke.id, userId: stroke.id.slice(0, stroke.id.indexOf(':')), points: stroke.points, end: stroke.end });
  // How many points arrived: the end-to-end test reads it (the overlay itself is out of any capture).
  received += stroke.points.length;
  document.documentElement.dataset.points = String(received);
  if (styles.size > 2 * board.size + 64) for (const key of styles.keys()) if (!board.has(key)) styles.delete(key);
  painter.kick();
});
window.addEventListener('resize', () => painter.kick());
