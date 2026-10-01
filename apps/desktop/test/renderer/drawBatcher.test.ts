// The pencil's batches (spec 2026-10-01-lapis-na-tela-design.md §3, §5): every ~50 ms, at most 64
// points, points nearer than ~0.002 to the previous one dropped, the last batch marked `end`.
import type { DrawPoint } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';
import { BATCH_MS, MIN_STEP, StrokeBatcher, newStrokeId, type StrokeBatch } from '../../src/renderer/features/draw/batcher.js';

function harness() {
  const sent: StrokeBatch[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let ids = 0;
  const batcher = new StrokeBatcher({
    send: (b) => sent.push(b),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    newId: () => `s${++ids}`,
  });
  /** Fires the pending timers, as if BATCH_MS went by. */
  const tick = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
  };
  return { batcher, sent, timers, tick };
}

describe('StrokeBatcher', () => {
  it('sends the points of a stroke every 50 ms, then the last batch with end', () => {
    const h = harness();
    expect(h.batcher.begin([0.1, 0.1])).toBe('s1');
    h.batcher.add([0.2, 0.1]);
    expect(h.sent).toEqual([]);
    expect(h.timers.map((t) => t.ms)).toEqual([BATCH_MS]);
    h.tick();
    expect(h.sent).toEqual([{ strokeId: 's1', points: [[0.1, 0.1], [0.2, 0.1]], end: false }]);
    h.batcher.add([0.3, 0.1]);
    h.batcher.end();
    expect(h.sent[1]).toEqual({ strokeId: 's1', points: [[0.3, 0.1]], end: true });
    // The timer of that batch was cancelled: nothing more goes out.
    h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.batcher.strokeId).toBeNull();
  });

  it('drops points nearer than 0.002 to the previous one kept', () => {
    const h = harness();
    h.batcher.begin([0.5, 0.5]);
    expect(h.batcher.add([0.5 + MIN_STEP / 2, 0.5])).toBe(false);
    expect(h.batcher.add([0.5, 0.5 + MIN_STEP * 0.9])).toBe(false);
    expect(h.batcher.add([0.5 + MIN_STEP, 0.5])).toBe(true);
    // Measured from the last point kept, not the last one seen.
    expect(h.batcher.add([0.5 + MIN_STEP * 1.5, 0.5])).toBe(false);
    h.tick();
    expect(h.sent[0]!.points).toEqual([[0.5, 0.5], [0.5 + MIN_STEP, 0.5]]);
  });

  it('never puts more than 64 points in a batch', () => {
    const h = harness();
    h.batcher.begin([0, 0]);
    for (let i = 1; i < 150; i++) h.batcher.add([i * 0.005, 0]);
    h.batcher.end();
    expect(h.sent.map((b) => b.points.length)).toEqual([64, 64, 22]);
    expect(h.sent.map((b) => b.end)).toEqual([false, false, true]);
    expect(h.sent.flatMap((b) => b.points)).toHaveLength(150);
  });

  it('ends with the last point again when nothing is pending (the server takes 1 to 64 points)', () => {
    const h = harness();
    h.batcher.begin([0.4, 0.4]);
    h.tick();
    h.batcher.add([0.4, 0.4 + MIN_STEP / 4]); // dropped
    h.batcher.end();
    expect(h.sent).toEqual([
      { strokeId: 's1', points: [[0.4, 0.4]], end: false },
      { strokeId: 's1', points: [[0.4, 0.4]], end: true },
    ]);
  });

  it('a tap is a one-point stroke', () => {
    const h = harness();
    h.batcher.begin([0.7, 0.2]);
    h.batcher.end();
    expect(h.sent).toEqual([{ strokeId: 's1', points: [[0.7, 0.2]], end: true }]);
  });

  it('begin ends a stroke still open, and add without a stroke does nothing', () => {
    const h = harness();
    expect(h.batcher.add([0.1, 0.1])).toBe(false);
    h.batcher.begin([0.1, 0.1]);
    h.batcher.begin([0.9, 0.9]);
    h.batcher.end();
    expect(h.sent).toEqual([
      { strokeId: 's1', points: [[0.1, 0.1]], end: true },
      { strokeId: 's2', points: [[0.9, 0.9]], end: true },
    ]);
    h.batcher.end();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps the batches under the server limit of 30 per second while drawing fast', () => {
    const h = harness();
    h.batcher.begin([0, 0]);
    // One second of a 240 Hz mouse: 12 points per 50 ms.
    let x = 0;
    for (let window = 0; window < 20; window++) {
      for (let i = 0; i < 12; i++) h.batcher.add([(x += 0.003) % 1, 0.5] as DrawPoint);
      h.tick();
    }
    expect(h.sent.length).toBe(20);
    expect(Math.max(...h.sent.map((b) => b.points.length))).toBeLessThanOrEqual(64);
  });
});

describe('newStrokeId', () => {
  it('is 11 base64url characters, from fresh random bytes', () => {
    const id = newStrokeId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(newStrokeId()).not.toBe(id);
    expect(newStrokeId((b) => b.fill(255))).toBe('__________8');
  });
});
