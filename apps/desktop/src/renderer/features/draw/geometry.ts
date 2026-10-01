// Where the picture is inside a <video> with object-fit: contain, and the normalized frame
// coordinates of the pencil (spec 2026-10-01-lapis-na-tela-design.md §3): 0 to 1 across the
// video frame, the black bars left out, so every screen size draws at the same spot.
import type { DrawPoint } from '@ghostlink/shared';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The picture's box inside a `boxWidth` × `boxHeight` element showing a `videoWidth` × `videoHeight`
 * frame with object-fit: contain (centered, bars on the sides or on top and bottom). Without a
 * frame size yet (no frame decoded), the whole box. null when the box is empty.
 */
export function containRect(boxWidth: number, boxHeight: number, videoWidth: number, videoHeight: number): Rect | null {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null;
  if (!(videoWidth > 0) || !(videoHeight > 0)) return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}

/**
 * A position in the element (CSS pixels from its top-left corner) as a point of the frame.
 * Outside the picture: null, or the nearest edge point with `clamp` (a stroke that leaves
 * the picture keeps going along its edge).
 */
export function toFrame(px: number, py: number, rect: Rect, clamp = false): DrawPoint | null {
  const x = (px - rect.x) / rect.width;
  const y = (py - rect.y) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!inside && !clamp) return null;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

/** A frame point back to element pixels. */
export function fromFrame(point: DrawPoint, rect: Rect): { x: number; y: number } {
  return { x: rect.x + point[0] * rect.width, y: rect.y + point[1] * rect.height };
}

/** ~4 px on a 1280-wide picture, proportional to the picture's size (spec §3), from 2 to 8 px. */
export function strokeWidth(rect: Rect): number {
  return Math.min(8, Math.max(2, rect.width / 320));
}
