// The microphone gate's decision (spec §8.4): voice activity with a threshold, or
// push-to-talk. Pure, so it is tested without WebAudio; gateProcessor.ts applies it.
import type { InputMode } from './settings.js';

/** How long voice activity stays open after the level drops (avoids clipping word ends). */
export const GATE_HOLD_MS = 300;
/** How long push-to-talk stays open after the key is released. */
export const PTT_TAIL_MS = 120;
export const SILENCE_DB = -100;

export interface GateState {
  open: boolean;
  /** Last time the gate had a reason to be open (voice above the line, or the key held). */
  lastActiveAt: number;
}

export interface GateInput {
  levelDb: number;
  now: number;
  mode: InputMode;
  thresholdDb: number;
  pttPressed: boolean;
}

export const closedGate: GateState = { open: false, lastActiveAt: Number.NEGATIVE_INFINITY };

export function nextGate(s: GateState, i: GateInput): GateState {
  const active = i.mode === 'ptt' ? i.pttPressed : i.levelDb >= i.thresholdDb;
  if (active) return { open: true, lastActiveAt: i.now };
  const hold = i.mode === 'ptt' ? PTT_TAIL_MS : GATE_HOLD_MS;
  return { open: s.open && i.now - s.lastActiveAt < hold, lastActiveAt: s.lastActiveAt };
}

/** Root-mean-square level of a sample buffer, in dBFS (silence is SILENCE_DB). */
export function rmsDb(samples: ArrayLike<number>): number {
  if (samples.length === 0) return SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}
