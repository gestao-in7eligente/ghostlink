// How long strokes live (spec 2026-10-01-lapis-na-tela-design.md §1, §5): ~3 s after the end,
// fading in the last half second, measured with an injected clock; and each person's color.
import { describe, expect, it } from 'vitest';
import { PENCIL_COLORS, PENCIL_PALETTE, labelText, pencilColor } from '../../src/renderer/features/draw/colors.js';
import { FADE_END_MS, FADE_START_MS, MAX_POINTS_PER_STROKE, MAX_STROKES, STALE_MS, StrokeStore, strokeAlpha } from '../../src/renderer/features/draw/strokes.js';

const BIA = 'b'.repeat(32);
const CAIO = 'c'.repeat(32);

function store() {
  const clock = { now: 1_000 };
  return { clock, board: new StrokeStore(() => clock.now) };
}

describe('strokeAlpha', () => {
  it('is 1 while drawing and for 2.5 s after the end, then fades to 0 at 3 s', () => {
    expect(FADE_START_MS).toBe(2_500);
    expect(FADE_END_MS).toBe(3_000);
    const ended = { endedAt: 10_000, updatedAt: 10_000 };
    expect(strokeAlpha({ endedAt: null, updatedAt: 10_000 }, 12_000)).toBe(1);
    expect(strokeAlpha(ended, 10_000)).toBe(1);
    expect(strokeAlpha(ended, 12_500)).toBe(1);
    expect(strokeAlpha(ended, 12_750)).toBeCloseTo(0.5, 6);
    expect(strokeAlpha(ended, 12_900)).toBeCloseTo(0.2, 6);
    expect(strokeAlpha(ended, 13_000)).toBe(0);
    expect(strokeAlpha(ended, 20_000)).toBe(0);
  });

  it('fades out a stroke whose end never came, STALE_MS after its last batch', () => {
    const lost = { endedAt: null, updatedAt: 0 };
    expect(strokeAlpha(lost, STALE_MS - FADE_END_MS - 1)).toBe(1);
    expect(strokeAlpha(lost, STALE_MS - 250)).toBeCloseTo(0.5, 6);
    expect(strokeAlpha(lost, STALE_MS)).toBe(0);
  });
});

describe('StrokeStore', () => {
  it('collects the batches of a stroke and drops it once it faded', () => {
    const { clock, board } = store();
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.1, 0.1]], end: false });
    clock.now += 50;
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.2, 0.2], [0.3, 0.3]], end: true });
    expect(board.visible()).toEqual([
      { stroke: { key: `${BIA}:s1`, userId: BIA, points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]], endedAt: 1_050, updatedAt: 1_050 }, alpha: 1 },
    ]);
    clock.now = 1_050 + 2_750;
    expect(board.visible()[0]!.alpha).toBeCloseTo(0.5, 6);
    clock.now = 1_050 + 3_000;
    expect(board.visible()).toEqual([]);
    expect(board.size).toBe(0);
  });

  it('keeps each person and each stroke apart, oldest first', () => {
    const { clock, board } = store();
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.1, 0.1]], end: true });
    clock.now += 1_000;
    board.apply({ key: `${CAIO}:s1`, userId: CAIO, points: [[0.9, 0.9]], end: false });
    expect(board.visible().map((v) => v.stroke.key)).toEqual([`${BIA}:s1`, `${CAIO}:s1`]);
    clock.now += 2_100; // Bia's ended 3.1 s ago; Caio is still drawing
    expect(board.visible().map((v) => v.stroke.key)).toEqual([`${CAIO}:s1`]);
  });

  it('ignores a batch after the end and an empty first batch', () => {
    const { board } = store();
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.1, 0.1]], end: true });
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.5, 0.5]], end: false });
    board.apply({ key: `${BIA}:s2`, userId: BIA, points: [], end: true });
    expect(board.visible().map((v) => v.stroke.points)).toEqual([[[0.1, 0.1]]]);
  });

  it('ends my own stroke with an empty last batch', () => {
    const { board } = store();
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [[0.1, 0.1]], end: false });
    board.apply({ key: `${BIA}:s1`, userId: BIA, points: [], end: true });
    expect(board.visible()[0]!.stroke.endedAt).toBe(1_000);
  });

  it('bounds the strokes and their points against a flood', () => {
    const { board } = store();
    for (let i = 0; i < MAX_STROKES + 10; i++) board.apply({ key: `${BIA}:s${i}`, userId: BIA, points: [[0.5, 0.5]], end: false });
    expect(board.size).toBe(MAX_STROKES);
    expect(board.has(`${BIA}:s0`)).toBe(false);
    expect(board.has(`${BIA}:s${MAX_STROKES + 9}`)).toBe(true);
    board.clear();
    const many = Array.from({ length: 64 }, (_, i) => [i / 64, 0.5] as [number, number]);
    for (let i = 0; i < 100; i++) board.apply({ key: `${CAIO}:big`, userId: CAIO, points: many, end: false });
    expect(board.visible()[0]!.stroke.points).toHaveLength(MAX_POINTS_PER_STROKE);
  });
});

describe('pencilColor: a color per person', () => {
  it('is a palette color, the same for the same person every time', () => {
    expect(PENCIL_COLORS).toEqual(Object.values(PENCIL_PALETTE));
    for (const id of [BIA, CAIO, '0123456789abcdef0123456789abcdef']) {
      expect(PENCIL_COLORS).toContain(pencilColor(id));
      expect(pencilColor(id)).toBe(pencilColor(id));
    }
    for (const color of PENCIL_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('spreads people over the whole palette', () => {
    const ids = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(32, '0'));
    const used = new Set(ids.map(pencilColor));
    expect(used.size).toBe(PENCIL_COLORS.length);
  });
});

describe('labelText', () => {
  it('keeps short names and cuts long ones with an ellipsis', () => {
    expect(labelText('  Bia ')).toBe('Bia');
    expect(labelText('Maria Eduarda dos Santos Oliveira')).toBe('Maria Eduarda dos Santo…');
    expect([...labelText('👻'.repeat(30))]).toHaveLength(24);
  });
});
