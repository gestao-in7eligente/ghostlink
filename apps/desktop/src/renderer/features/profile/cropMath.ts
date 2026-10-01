// The crop of the profile photo (spec 2026-10-01-foto-de-perfil §2), pure: the modal keeps a
// view (zoom and where the image sits) and turns it into a square of the original image.

/** The crop frame's side in the modal, in CSS pixels; the circle fills it. */
export const CROP_FRAME = 320;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

export interface ImageSize {
  width: number;
  height: number;
}

/** Zoom, and the offset of the image's centre from the frame's centre, in frame pixels. */
export interface CropView {
  zoom: number;
  x: number;
  y: number;
}

/** A square of the original image, in whole pixels. */
export interface CropSquare {
  x: number;
  y: number;
  side: number;
}

// `+ 0` turns -0 into 0.
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi) + 0;

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
}

/** Frame pixels per image pixel. Zoom 1: the image's shorter side fills the frame. */
function scaleOf(size: ImageSize, zoom: number, frame: number): number {
  return (frame / Math.min(size.width, size.height)) * clampZoom(zoom);
}

/** The view moved back inside its limits: the image always covers the whole frame. */
export function clampView(size: ImageSize, view: CropView, frame = CROP_FRAME): CropView {
  const zoom = clampZoom(view.zoom);
  const scale = scaleOf(size, zoom, frame);
  const maxX = Math.max(0, (size.width * scale - frame) / 2);
  const maxY = Math.max(0, (size.height * scale - frame) / 2);
  return { zoom, x: clamp(Number.isFinite(view.x) ? view.x : 0, -maxX, maxX), y: clamp(Number.isFinite(view.y) ? view.y : 0, -maxY, maxY) };
}

/** A drag of (dx, dy) frame pixels. */
export function dragView(size: ImageSize, view: CropView, dx: number, dy: number, frame = CROP_FRAME): CropView {
  return clampView(size, { zoom: view.zoom, x: view.x + dx, y: view.y + dy }, frame);
}

/** A new zoom that keeps the point of the image under the frame's centre where it is. */
export function zoomView(size: ImageSize, view: CropView, zoom: number, frame = CROP_FRAME): CropView {
  const ratio = clampZoom(zoom) / clampZoom(view.zoom);
  return clampView(size, { zoom, x: view.x * ratio, y: view.y * ratio }, frame);
}

/** Where the modal draws the image inside the frame, in frame pixels. */
export function imageBox(size: ImageSize, view: CropView, frame = CROP_FRAME): { left: number; top: number; width: number; height: number } {
  const v = clampView(size, view, frame);
  const scale = scaleOf(size, v.zoom, frame);
  const width = size.width * scale;
  const height = size.height * scale;
  return { left: frame / 2 + v.x - width / 2 + 0, top: frame / 2 + v.y - height / 2 + 0, width, height };
}

/** The square of the original image under the frame: whole pixels, never outside the image. */
export function cropSquare(size: ImageSize, view: CropView, frame = CROP_FRAME): CropSquare {
  const v = clampView(size, view, frame);
  const scale = scaleOf(size, v.zoom, frame);
  const side = clamp(Math.round(frame / scale), 1, Math.min(size.width, size.height));
  const cx = size.width / 2 - v.x / scale;
  const cy = size.height / 2 - v.y / scale;
  return {
    x: clamp(Math.round(cx - side / 2), 0, size.width - side),
    y: clamp(Math.round(cy - side / 2), 0, size.height - side),
    side,
  };
}
