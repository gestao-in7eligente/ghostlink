// The pencil's coordinates (spec 2026-10-01-lapis-na-tela-design.md §3, §5): normalized to the
// video frame, the object-fit: contain letterbox left out, whatever the shapes of box and frame.
import { describe, expect, it } from 'vitest';
import { containRect, fromFrame, strokeWidth, toFrame } from '../../src/renderer/features/draw/geometry.js';

describe('containRect: where the picture is inside the <video>', () => {
  it('puts black bars on the sides of a 16:9 frame in a 4:3 box', () => {
    expect(containRect(800, 600, 1920, 1080)).toEqual({ x: 0, y: 75, width: 800, height: 450 });
  });

  it('puts bars on the sides of a 4:3 frame in a 16:9 box', () => {
    expect(containRect(1600, 900, 1024, 768)).toEqual({ x: 200, y: 0, width: 1200, height: 900 });
  });

  it('fills a box of the same shape', () => {
    expect(containRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it('handles an ultrawide monitor in a 16:9 tile and a portrait monitor', () => {
    const wide = containRect(1280, 720, 3440, 1440)!;
    expect(wide.x).toBe(0);
    expect(wide.width).toBe(1280);
    expect(wide.height).toBeCloseTo((1280 * 1440) / 3440, 6);
    expect(wide.y).toBeCloseTo((720 - wide.height) / 2, 6);
    const tall = containRect(1280, 720, 1080, 1920)!;
    expect(tall.y).toBe(0);
    expect(tall.height).toBe(720);
    expect(tall.width).toBeCloseTo(405, 6);
    expect(tall.x).toBeCloseTo((1280 - 405) / 2, 6);
  });

  it('uses the whole box until a frame is decoded, and nothing for an empty box', () => {
    expect(containRect(640, 360, 0, 0)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(containRect(0, 360, 1920, 1080)).toBeNull();
    expect(containRect(640, 0, 1920, 1080)).toBeNull();
  });
});

describe('toFrame and fromFrame', () => {
  const rect = containRect(800, 600, 1920, 1080)!; // bars of 75 px on top and bottom

  it('maps the picture corners to 0 and 1, the bars excluded', () => {
    expect(toFrame(0, 75, rect)).toEqual([0, 0]);
    expect(toFrame(800, 525, rect)).toEqual([1, 1]);
    expect(toFrame(400, 300, rect)).toEqual([0.5, 0.5]);
  });

  it('refuses a point on a black bar, or clamps it to the edge while a stroke goes on', () => {
    expect(toFrame(400, 40, rect)).toBeNull();
    expect(toFrame(400, 560, rect)).toBeNull();
    expect(toFrame(400, 40, rect, true)).toEqual([0.5, 0]);
    expect(toFrame(-20, 560, rect, true)).toEqual([0, 1]);
  });

  it('round-trips to the same place in another size of the same frame', () => {
    const point = toFrame(200, 187.5, rect)!;
    expect(point).toEqual([0.25, 0.25]);
    // The same point on a 1920×1080 fullscreen of the same stream lands at the same spot of the picture.
    expect(fromFrame(point, containRect(1920, 1080, 1920, 1080)!)).toEqual({ x: 480, y: 270 });
    // And on a 4:3 tile with side bars.
    const tile = containRect(400, 400, 1920, 1080)!;
    expect(fromFrame(point, tile)).toEqual({ x: 100, y: tile.y + 0.25 * tile.height });
  });
});

describe('strokeWidth', () => {
  it('is ~4 px on a 1280-wide picture, proportional, between 2 and 8 px', () => {
    expect(strokeWidth({ x: 0, y: 0, width: 1280, height: 720 })).toBe(4);
    expect(strokeWidth({ x: 0, y: 0, width: 1920, height: 1080 })).toBe(6);
    expect(strokeWidth({ x: 0, y: 0, width: 96, height: 54 })).toBe(2);
    expect(strokeWidth({ x: 0, y: 0, width: 5120, height: 2880 })).toBe(8);
  });
});
