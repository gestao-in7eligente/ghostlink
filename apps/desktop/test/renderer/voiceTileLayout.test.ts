// The stage's tile grid (Discord's call screen): 16:9 tiles as large as the stage allows.
import { describe, expect, it } from 'vitest';
import { MIN_TILE_WIDTH, fitTiles } from '../../src/renderer/features/voice/tileLayout.js';

describe('fitTiles', () => {
  it('stacks two tiles in a tall stage, like the reference (874×492 tiles in a 1544 px stage)', () => {
    expect(fitTiles(2, 1512, 992)).toEqual({ columns: 1, width: 874 });
  });

  it('puts two tiles side by side in a wide, short stage', () => {
    expect(fitTiles(2, 1600, 500)).toEqual({ columns: 2, width: 796 });
  });

  it('keeps every tile inside the box', () => {
    for (const [count, width, height] of [
      [1, 500, 600],
      [3, 900, 500],
      [5, 1200, 700],
      [9, 1500, 900],
    ] as const) {
      const { columns, width: w } = fitTiles(count, width, height);
      const rows = Math.ceil(count / columns);
      expect(columns * w + (columns - 1) * 8).toBeLessThanOrEqual(width);
      expect(rows * ((w * 9) / 16) + (rows - 1) * 8).toBeLessThanOrEqual(height);
    }
  });

  it('stops shrinking at the minimum width and lets the stage scroll', () => {
    const { columns, width } = fitTiles(40, 700, 300);
    expect(width).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
    expect(columns).toBe(4);
  });

  it('waits for a measured box', () => {
    expect(fitTiles(3, 0, 0)).toEqual({ columns: 1, width: 0 });
  });
});
