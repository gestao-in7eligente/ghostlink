import { describe, expect, it } from 'vitest';
import { GATE_HOLD_MS, PTT_TAIL_MS, closedGate, nextGate, rmsDb } from '../../src/renderer/features/voice/gateLogic.js';

const vad = { mode: 'vad' as const, thresholdDb: -50, pttPressed: false };

describe('voice activity gate (spec §8.4: threshold and meter)', () => {
  it('opens above the threshold and holds briefly after the voice drops, so words are not clipped', () => {
    let g = nextGate(closedGate, { ...vad, levelDb: -70, now: 0 });
    expect(g.open).toBe(false);
    g = nextGate(g, { ...vad, levelDb: -30, now: 100 });
    expect(g.open).toBe(true);
    g = nextGate(g, { ...vad, levelDb: -80, now: 100 + GATE_HOLD_MS - 1 });
    expect(g.open).toBe(true);
    g = nextGate(g, { ...vad, levelDb: -80, now: 100 + GATE_HOLD_MS });
    expect(g.open).toBe(false);
  });

  it('the threshold is inclusive and follows the setting live', () => {
    expect(nextGate(closedGate, { ...vad, levelDb: -50, now: 0 }).open).toBe(true);
    expect(nextGate(closedGate, { ...vad, thresholdDb: -20, levelDb: -30, now: 0 }).open).toBe(false);
    expect(nextGate(closedGate, { ...vad, thresholdDb: -100, levelDb: -99, now: 0 }).open).toBe(true);
  });

  it('push-to-talk ignores the level: open while the key is held, plus a short tail', () => {
    const ptt = { mode: 'ptt' as const, thresholdDb: -50 };
    let g = nextGate(closedGate, { ...ptt, pttPressed: false, levelDb: 0, now: 0 });
    expect(g.open).toBe(false);
    g = nextGate(g, { ...ptt, pttPressed: true, levelDb: -100, now: 10 });
    expect(g.open).toBe(true);
    g = nextGate(g, { ...ptt, pttPressed: false, levelDb: 0, now: 10 + PTT_TAIL_MS - 1 });
    expect(g.open).toBe(true);
    g = nextGate(g, { ...ptt, pttPressed: false, levelDb: 0, now: 10 + PTT_TAIL_MS });
    expect(g.open).toBe(false);
  });

  it('rmsDb measures a buffer in dBFS, with silence floored at -100', () => {
    expect(rmsDb(new Float32Array(128))).toBe(-100);
    expect(rmsDb(new Float32Array(128).fill(1))).toBeCloseTo(0, 5);
    expect(rmsDb(new Float32Array(128).fill(0.1))).toBeCloseTo(-20, 5);
    expect(rmsDb(new Float32Array(0))).toBe(-100);
  });
});
