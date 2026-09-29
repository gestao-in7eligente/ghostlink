// The microphone gate as a LiveKit track processor (spec §8.4): the published track is
// the gate's output, silent unless voice activity is above the threshold or the
// push-to-talk key is held. Muting by gain sends no signaling and no ungated audio.
import type { ProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { SILENCE_DB, closedGate, nextGate, rmsDb, type GateState } from './gateLogic.js';
import type { InputMode } from './settings.js';

export interface GateControls {
  mode(): InputMode;
  thresholdDb(): number;
  pttPressed(): boolean;
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
  #source: MediaStreamAudioSourceNode | null = null;
  #analyser: AnalyserNode | null = null;
  #gain: GainNode | null = null;
  #destination: MediaStreamAudioDestinationNode | null = null;
  #samples: Float32Array<ArrayBuffer> = new Float32Array(1024);
  #timer: ReturnType<typeof setInterval> | null = null;
  #gate: GateState = closedGate;
  #lastLevelAt = 0;

  /** `ctx` is the app's own AudioContext: LiveKit passes none on restart. */
  constructor(controls: GateControls, ctx: AudioContext) {
    this.#controls = controls;
    this.#ctx = ctx;
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
    source.connect(analyser);
    source.connect(gain);
    gain.connect(this.#destination);
    this.#source = source;
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
    const next = nextGate(this.#gate, {
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

  async restart(opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> {
    this.#disconnect();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.#disconnect();
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
    this.#source?.disconnect();
    this.#analyser?.disconnect();
    this.#gain?.disconnect();
    this.#source = null;
    this.#analyser = null;
    this.#gain = null;
  }
}

/** A standalone level meter for the settings' microphone test (no call needed). */
export function startLevelMeter(stream: MediaStream, ctx: AudioContext, onLevel: (db: number) => void): () => void {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    onLevel(rmsDb(samples));
  }, LEVEL_EVERY_MS);
  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    onLevel(SILENCE_DB);
  };
}
