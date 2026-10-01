import { describe, expect, it } from 'vitest';
import { CROP_FRAME, MAX_ZOOM, clampView, cropSquare, dragView, imageBox, zoomView, type CropView } from '../../src/renderer/features/profile/cropMath.js';

const LANDSCAPE = { width: 300, height: 200 };
const PORTRAIT = { width: 200, height: 300 };
const SQUARE = { width: 512, height: 512 };
const START: CropView = { zoom: 1, x: 0, y: 0 };

/** The square never leaves the image (the circle never shows empty space). */
function inside(size: { width: number; height: number }, sq: { x: number; y: number; side: number }) {
  expect(sq.side).toBeGreaterThanOrEqual(1);
  expect(sq.x).toBeGreaterThanOrEqual(0);
  expect(sq.y).toBeGreaterThanOrEqual(0);
  expect(sq.x + sq.side).toBeLessThanOrEqual(size.width);
  expect(sq.y + sq.side).toBeLessThanOrEqual(size.height);
  for (const v of [sq.x, sq.y, sq.side]) expect(Number.isInteger(v)).toBe(true);
}

describe('cropSquare (spec §2: the crop from zoom and offset)', () => {
  it('zoom 1 centres the image, its shorter side filling the circle', () => {
    expect(cropSquare(LANDSCAPE, START)).toEqual({ x: 50, y: 0, side: 200 });
    expect(cropSquare(PORTRAIT, START)).toEqual({ x: 0, y: 50, side: 200 });
    expect(cropSquare(SQUARE, START)).toEqual({ x: 0, y: 0, side: 512 });
  });

  it('a square image at zoom 1 cannot move at all', () => {
    expect(dragView(SQUARE, START, 80, -60)).toEqual(START);
  });

  it('moving the image right shows more of its left side, down shows more of its top', () => {
    // 300×200 at zoom 1: 1.6 frame pixels per image pixel; 16 frame px = 10 image px.
    expect(cropSquare(LANDSCAPE, dragView(LANDSCAPE, START, 16, 0))).toEqual({ x: 40, y: 0, side: 200 });
    expect(cropSquare(LANDSCAPE, dragView(LANDSCAPE, START, -16, 0))).toEqual({ x: 60, y: 0, side: 200 });
    expect(cropSquare(PORTRAIT, dragView(PORTRAIT, START, 0, 16))).toEqual({ x: 0, y: 40, side: 200 });
  });

  it('stops at every edge of the image', () => {
    expect(cropSquare(LANDSCAPE, dragView(LANDSCAPE, START, 10_000, 0))).toEqual({ x: 0, y: 0, side: 200 });
    expect(cropSquare(LANDSCAPE, dragView(LANDSCAPE, START, -10_000, 0))).toEqual({ x: 100, y: 0, side: 200 });
    expect(cropSquare(PORTRAIT, dragView(PORTRAIT, START, 0, 10_000))).toEqual({ x: 0, y: 0, side: 200 });
    expect(cropSquare(PORTRAIT, dragView(PORTRAIT, START, 0, -10_000))).toEqual({ x: 0, y: 100, side: 200 });
    // Up and down on a landscape image at zoom 1: nothing to show beyond the edges.
    expect(dragView(LANDSCAPE, START, 0, 500)).toEqual(START);
  });

  it('max zoom shows a fifth of the shorter side, and still stops at the corners', () => {
    const zoomed = zoomView(LANDSCAPE, START, MAX_ZOOM);
    expect(cropSquare(LANDSCAPE, zoomed)).toEqual({ x: 130, y: 80, side: 40 });
    for (const [dx, dy] of [
      [10_000, 10_000],
      [-10_000, 10_000],
      [10_000, -10_000],
      [-10_000, -10_000],
    ] as const) {
      inside(LANDSCAPE, cropSquare(LANDSCAPE, dragView(LANDSCAPE, zoomed, dx, dy)));
    }
    expect(cropSquare(LANDSCAPE, dragView(LANDSCAPE, zoomed, -10_000, -10_000))).toEqual({ x: 260, y: 160, side: 40 });
  });

  it('keeps the zoom between 1 and 5, whatever comes in', () => {
    for (const zoom of [0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(clampView(LANDSCAPE, { zoom, x: 0, y: 0 }).zoom).toBe(1);
    expect(clampView(LANDSCAPE, { zoom: 12, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  });

  it('zooming keeps the point under the centre of the circle in place', () => {
    const moved = dragView(LANDSCAPE, zoomView(LANDSCAPE, START, 2), 32, 0);
    const before = cropSquare(LANDSCAPE, moved);
    const after = cropSquare(LANDSCAPE, zoomView(LANDSCAPE, moved, 4));
    expect(after.x + after.side / 2).toBeCloseTo(before.x + before.side / 2, 0);
    expect(after.y + after.side / 2).toBeCloseTo(before.y + before.side / 2, 0);
    expect(after.side).toBe(50);
  });

  it('zooming out pulls the image back so it still covers the circle', () => {
    const atEdge = dragView(LANDSCAPE, zoomView(LANDSCAPE, START, 5), 10_000, 0);
    const out = zoomView(LANDSCAPE, atEdge, 1);
    expect(out).toEqual({ zoom: 1, x: 80, y: 0 });
    expect(cropSquare(LANDSCAPE, out)).toEqual({ x: 0, y: 0, side: 200 });
  });

  it('works for tiny and huge images', () => {
    const tiny = { width: 3, height: 1 };
    inside(tiny, cropSquare(tiny, zoomView(tiny, START, 5)));
    expect(cropSquare(tiny, zoomView(tiny, START, 5)).side).toBe(1);
    const huge = { width: 8000, height: 2000 };
    inside(huge, cropSquare(huge, dragView(huge, zoomView(huge, START, 3.3), -999, 123)));
  });
});

describe('imageBox (where the modal draws the image)', () => {
  it('covers the frame at zoom 1, centred', () => {
    expect(imageBox(LANDSCAPE, START)).toEqual({ left: -80, top: 0, width: 480, height: 320 });
    expect(imageBox(SQUARE, START)).toEqual({ left: 0, top: 0, width: CROP_FRAME, height: CROP_FRAME });
  });

  it('follows the zoom and the offset', () => {
    const view = dragView(LANDSCAPE, zoomView(LANDSCAPE, START, 2), 100, -50);
    const box = imageBox(LANDSCAPE, view);
    expect(box.width).toBe(960);
    expect(box.height).toBe(640);
    expect(box.left).toBe(CROP_FRAME / 2 + view.x - 480);
    expect(box.top).toBe(CROP_FRAME / 2 + view.y - 320);
    // Never a gap inside the frame.
    expect(box.left).toBeLessThanOrEqual(0);
    expect(box.top).toBeLessThanOrEqual(0);
    expect(box.left + box.width).toBeGreaterThanOrEqual(CROP_FRAME);
    expect(box.top + box.height).toBeGreaterThanOrEqual(CROP_FRAME);
  });
});
