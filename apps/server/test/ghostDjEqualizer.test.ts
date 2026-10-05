import { describe, expect, it } from 'vitest';
import { GHOST_DJ_EQ_BANDS, GHOST_DJ_EQ_PRESETS } from '@ghostlink/shared';
import { DjMixer } from '../src/ghostDj/equalizer.js';

const RATE = 48_000;
const FRAME = 960;

/** Stereo s16le frames of a sum of tones (the same in both channels), from sample `from` on. */
function tones(freqs: readonly number[], amplitude: number, from: number): Buffer {
  const buf = Buffer.alloc(FRAME * 4);
  for (let i = 0; i < FRAME; i++) {
    const v = Math.round(freqs.reduce((sum, f) => sum + amplitude * Math.sin((2 * Math.PI * f * (from + i)) / RATE), 0));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

/** Plays `seconds` of the tones through the mixer; returns the left channel. */
function play(mixer: DjMixer, freqs: readonly number[], amplitude: number, seconds: number, gains: () => readonly number[], volume: () => number = () => 1, from = 0): Float64Array {
  const frames = Math.round((seconds * RATE) / FRAME);
  const left = new Float64Array(frames * FRAME);
  for (let f = 0; f < frames; f++) {
    const out = mixer.frame(tones(freqs, amplitude, from + f * FRAME), 0, FRAME, volume(), gains());
    for (let i = 0; i < FRAME; i++) left[f * FRAME + i] = out[i * 2]!;
  }
  return left;
}

/** The amplitude of `freq` over the last `seconds` (whole cycles: no leakage). */
function amplitude(x: Float64Array, freq: number, seconds: number): number {
  const n = seconds * RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const v = x[x.length - n + i]!;
    re += v * Math.cos((2 * Math.PI * freq * i) / RATE);
    im -= v * Math.sin((2 * Math.PI * freq * i) / RATE);
  }
  return (2 * Math.hypot(re, im)) / n;
}

const dB = (ratio: number) => 20 * Math.log10(ratio);

/** The largest sample-to-sample step in x[from, to). */
function maxStep(x: Float64Array, from: number, to: number): number {
  let max = 0;
  for (let i = Math.max(1, from); i < to; i++) max = Math.max(max, Math.abs(x[i]! - x[i - 1]!));
  return max;
}

describe('Ghost DJ equalizer', () => {
  it('a tone at each band’s frequency moves by that band’s gain; the others stay put', () => {
    for (const [band, freq] of GHOST_DJ_EQ_BANDS.entries()) {
      for (const gain of [12, -12, 5]) {
        const gains = GHOST_DJ_EQ_BANDS.map((_, i) => (i === band ? gain : 0));
        const out = play(new DjMixer(), [freq], 2_000, 1, () => gains);
        expect(dB(amplitude(out, freq, 0.5) / 2_000), `${freq} Hz at ${gain} dB`).toBeCloseTo(gain, 0);
      }
    }
    // Flat: the sound passes unchanged, to the sample.
    const flat = play(new DjMixer(), [1_000], 8_000, 0.1, () => [0, 0, 0, 0, 0]);
    expect(flat.every((v, i) => v === Math.round(8_000 * Math.sin((2 * Math.PI * 1_000 * i) / RATE)))).toBe(true);
    // A band two octaves away barely moves (+12 dB at 3.6 kHz, measured at 14 kHz and 910 Hz).
    const far = play(new DjMixer(), [910, 14_000], 2_000, 1, () => [0, 0, 0, 12, 0]);
    expect(Math.abs(dB(amplitude(far, 910, 0.5) / 2_000))).toBeLessThan(2);
    expect(Math.abs(dB(amplitude(far, 14_000, 0.5) / 2_000))).toBeLessThan(2);
  });

  it('switching presets and the volume glides: no jump, only steps the size of the steady sound’s', () => {
    // Low tones: their own sample-to-sample steps are small, so a click (a jump) stands out.
    const freqs = [60, 230];
    const mixer = new DjMixer();
    let gains: readonly number[] = GHOST_DJ_EQ_PRESETS.default;
    let volume = 0.25;
    const x = new Float64Array(RATE * 3);
    for (let at = 0; at < x.length; at += FRAME) {
      // At 1 s: "Graves+" and full volume at once; at 2 s: a far custom setting.
      if (at === RATE) {
        gains = GHOST_DJ_EQ_PRESETS.bass;
        volume = 1;
      }
      if (at === RATE * 2) gains = [-12, 12, -12, 12, -12];
      const frame = mixer.frame(tones(freqs, 3_000, at), 0, FRAME, volume, gains);
      for (let i = 0; i < FRAME; i++) x[at + i] = frame[i * 2]!;
    }
    // Every switch settles within 0.6 s. While a band glides its sound grows or shrinks a little
    // faster than steady (steps up to ~1.2x); switching at once jumps by over 1.7x.
    const before = maxStep(x, RATE / 2, RATE);
    const bass = maxStep(x, RATE * 1.6, RATE * 2);
    const custom = maxStep(x, RATE * 2.6, RATE * 3);
    expect(maxStep(x, RATE - FRAME, RATE * 1.6)).toBeLessThanOrEqual(Math.max(before, bass) * 1.5);
    expect(maxStep(x, RATE * 2 - FRAME, RATE * 2.6)).toBeLessThanOrEqual(Math.max(bass, custom) * 1.5);
    expect(mixer.current).toEqual([-12, 12, -12, 12, -12]);
  });

  it('peaks over 85% of full scale bend instead of clipping', () => {
    const out = play(new DjMixer(), [60], 30_000, 0.5, () => [12, 0, 0, 0, 0]);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(32_767);
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(30_000);
    // The curve is smooth: no flat tops (two equal neighbours at the peak).
    expect(maxStep(out, RATE / 4, RATE / 2)).toBeGreaterThan(0);
  });
});
