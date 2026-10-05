import { GHOST_DJ_EQ_BANDS } from '@ghostlink/shared';

/**
 * The Ghost DJ's sound on its way to the encoder (spec 2026-10-02-ghost-dj-som-e-equalizador §2):
 * the 5-band equalizer, the volume and a soft limiter, on 20 ms frames of s16le stereo PCM.
 *
 * - Each band is a peaking ("bell") filter at its frequency: a tone there moves by the band's
 *   gain. It is a trapezoidal state-variable filter (A. Simper, Cytomic), whose state stays
 *   valid while its gain changes, unlike a biquad's.
 * - Changes never click: a band's gain glides sample by sample (48 dB/s, so -12 to +12 dB takes
 *   half a second) and the volume ramps across a frame.
 * - Above 85% of full scale the limiter bends the peaks smoothly instead of clipping them.
 */
const RATE = 48_000;
const CHANNELS = 2;
/** Bandwidth of each band: about 1.4 octaves, so neighbours (2 octaves apart) overlap a little. */
const Q = 1;
/** How fast a band's gain glides, per sample (as a factor of the filter's A = 10^(dB/40)). */
const GLIDE = 10 ** (48 / RATE / 40);
const KNEE = 0.85 * 32_767;
const FULL = 32_767;

/** One band's fixed part: g = tan(pi f / fs). */
const BAND_G = GHOST_DJ_EQ_BANDS.map((f) => Math.tan((Math.PI * f) / RATE));

/** Soft limiter: unchanged up to the knee, then a tanh curve that reaches full scale only at infinity. */
function limit(v: number): number {
  const m = Math.abs(v);
  if (m <= KNEE) return v;
  const over = KNEE + (FULL - KNEE) * Math.tanh((m - KNEE) / (FULL - KNEE));
  return v < 0 ? -over : over;
}

const amplitudeOf = (db: number) => 10 ** (db / 40);

/** One playback's equalizer and volume, with the filters' memory (a new one per DJ session). */
export class DjMixer {
  /** Each band's A = 10^(dB/40) now, gliding toward its target. */
  readonly #a: number[] = GHOST_DJ_EQ_BANDS.map(() => 1);
  /** Trapezoidal integrator states: [band][channel * 2 + (0: ic1eq, 1: ic2eq)]. */
  readonly #state: Float64Array[] = GHOST_DJ_EQ_BANDS.map(() => new Float64Array(CHANNELS * 2));
  #volume: number | null = null;

  /** The gains the bands play at now, in dB (tests). */
  get current(): number[] {
    return this.#a.map((a) => Math.round(40 * Math.log10(a) * 1_000) / 1_000);
  }

  /**
   * One frame of `buf` at `offset` (`samples` per channel, interleaved stereo) through the
   * equalizer (`gains`: the target per band, dB) and the volume (`gain`: linear).
   */
  frame(buf: Buffer, offset: number, samples: number, gain: number, gains: readonly number[]): Int16Array {
    const out = new Int16Array(samples * CHANNELS);
    const fromGain = this.#volume ?? gain;
    this.#volume = gain;
    const targets = GHOST_DJ_EQ_BANDS.map((_, b) => amplitudeOf(gains[b] ?? 0));
    const bands = this.#a.length;
    for (let i = 0; i < samples; i++) {
      const volume = fromGain + ((gain - fromGain) * (i + 1)) / samples;
      let left = buf.readInt16LE(offset + i * 4);
      let right = buf.readInt16LE(offset + i * 4 + 2);
      for (let b = 0; b < bands; b++) {
        let a = this.#a[b]!;
        const target = targets[b]!;
        if (a !== target) {
          a = a < target ? Math.min(target, a * GLIDE) : Math.max(target, a / GLIDE);
          this.#a[b] = a;
        }
        // At 0 dB a band adds nothing (exactly), but its integrators keep following the signal.
        left = this.#tick(b, 0, left, a);
        right = this.#tick(b, 1, right, a);
      }
      out[i * 2] = Math.round(limit(left * volume));
      out[i * 2 + 1] = Math.round(limit(right * volume));
    }
    return out;
  }

  /** One sample through band `b`'s bell filter (gain factor A = `a`) for one channel. */
  #tick(b: number, ch: number, v0: number, a: number): number {
    const g = BAND_G[b]!;
    const k = 1 / (Q * a);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const st = this.#state[b]!;
    const i1 = ch * 2;
    const ic1 = st[i1]!;
    const ic2 = st[i1 + 1]!;
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    st[i1] = 2 * v1 - ic1;
    st[i1 + 1] = 2 * v2 - ic2;
    return v0 + k * (a * a - 1) * v1;
  }
}
