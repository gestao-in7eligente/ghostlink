// The microphone gate as a LiveKit track processor (spec §8.4): the published track is
// the gate's output, silent unless voice activity is above the threshold or the
// push-to-talk key is held. Muting by gain sends no signaling and no ungated audio.
// The graph is microphone → noise suppressor (optional) → analyser and gain → output, so the
// gate decides on the cleaned sound (noise suppression spec 2026-10-01 §2).
import type { ProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { SILENCE_DB, closedGate, nextGate, rmsDb, type GateState } from './gateLogic.js';
import { SuppressorChain, type SuppressorNode } from './noiseSuppression.js';
import type { InputMode } from './settings.js';

export interface GateControls {
  mode(): InputMode;
  thresholdDb(): number;
  pttPressed(): boolean;
  /** Muted or deafened (by me or the server): the gate stays shut, also while the microphone reopens. */
  muted?(): boolean;
  /** The live input level (dBFS), about ten times a second. */
  onLevel?(db: number): void;
  /** The gate opened or closed. */
  onOpen?(open: boolean): void;
}

const TICK_MS = 20;
const LEVEL_EVERY_MS = 100;
const RAMP_S = 0.012;

export class GateProcessor implements TrackProcessor<Track.Kind.Audio> {
  readonly name = 'ghostlink-voice-gate';
  processedTrack?: MediaStreamTrack;
  readonly #controls: GateControls;
  readonly #ctx: AudioContext;
  #analyser: AnalyserNode | null = null;
  #gain: GainNode | null = null;
  #destination: MediaStreamAudioDestinationNode | null = null;
  /** microphone → [noise suppressor] → analyser and gain. */
  readonly #chain: SuppressorChain<AudioNode>;
  #samples: Float32Array<ArrayBuffer> = new Float32Array(1024);
  #timer: ReturnType<typeof setInterval> | null = null;
  #gate: GateState = closedGate;
  #lastLevelAt = 0;

  /** `ctx` is the app's own AudioContext: LiveKit passes none on restart. The gate owns `suppressor`. */
  constructor(controls: GateControls, ctx: AudioContext, suppressor: SuppressorNode<AudioNode> | null = null) {
    this.#controls = controls;
    this.#ctx = ctx;
    this.#chain = new SuppressorChain(suppressor);
  }

  async init(opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> {
    const ctx = this.#ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // The same output track across restarts (device switches), so the sender keeps it.
    this.#destination ??= ctx.createMediaStreamDestination();
    gain.connect(this.#destination);
    this.#chain.attach(source, [analyser, gain]);
    this.#analyser = analyser;
    this.#gain = gain;
    this.#samples = new Float32Array(analyser.fftSize);
    this.#gate = closedGate;
    this.processedTrack = this.#destination.stream.getAudioTracks()[0];
    this.#timer = setInterval(() => this.update(), TICK_MS);
  }

  /** Re-evaluates now (push-to-talk key events call this so the key feels instant). */
  update(): void {
    const analyser = this.#analyser;
    const gain = this.#gain;
    if (!analyser || !gain) return;
    analyser.getFloatTimeDomainData(this.#samples);
    const levelDb = rmsDb(this.#samples);
    const now = performance.now();
    const next = this.#controls.muted?.()
      ? closedGate
      : nextGate(this.#gate, {
          levelDb,
          now,
          mode: this.#controls.mode(),
          thresholdDb: this.#controls.thresholdDb(),
          pttPressed: this.#controls.pttPressed(),
        });
    if (next.open !== this.#gate.open) {
      gain.gain.setTargetAtTime(next.open ? 1 : 0, this.#ctx.currentTime, RAMP_S);
      this.#controls.onOpen?.(next.open);
    }
    this.#gate = next;
    if (now - this.#lastLevelAt >= LEVEL_EVERY_MS) {
      this.#lastLevelAt = now;
      this.#controls.onLevel?.(levelDb);
    }
  }

  /**
   * Puts `next` in front of the gate, also during a call, and destroys the previous one.
   * The swap happens in one task and the gain stays the only way to the output, so the
   * published audio is never ungated.
   */
  setSuppressor(next: SuppressorNode<AudioNode> | null): void {
    this.#chain.set(next);
  }

  async restart(opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> {
    this.#disconnect();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.#disconnect();
    this.#chain.destroy();
    this.#destination?.stream.getTracks().forEach((t) => t.stop());
    this.#destination = null;
    this.processedTrack = undefined;
    this.#controls.onLevel?.(SILENCE_DB);
    this.#controls.onOpen?.(false);
  }

  #disconnect(): void {
    if (this.#gate.open) this.#controls.onOpen?.(false);
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    // The suppressor stays for the restart (a device switch).
    this.#chain.detach();
    this.#analyser?.disconnect();
    this.#gain?.disconnect();
    this.#analyser = null;
    this.#gain = null;
  }
}

/**
 * A standalone level meter for the settings' microphone test (no call needed), through the
 * same noise suppressor as a call so the effect shows (noise spec §2). It owns `suppressor`.
 */
export function startLevelMeter(stream: MediaStream, ctx: AudioContext, onLevel: (db: number) => void, suppressor: SuppressorNode<AudioNode> | null = null): () => void {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const chain = new SuppressorChain<AudioNode>(suppressor);
  chain.attach(source, [analyser]);
  const samples = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    onLevel(rmsDb(samples));
  }, LEVEL_EVERY_MS);
  return () => {
    clearInterval(timer);
    chain.destroy();
    analyser.disconnect();
    onLevel(SILENCE_DB);
  };
}
