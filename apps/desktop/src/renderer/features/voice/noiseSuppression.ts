// Noise suppression (noise suppression spec 2026-10-01): which suppressor runs between the
// microphone and the gate, what the microphone is asked for, and the fallback to the
// browser's own suppression when a WebAssembly suppressor cannot load. The browser parts
// (fetching, AudioWorklet, WebAssembly) come in through a SuppressorBackend, so this is
// tested with fakes; noiseBackend.ts is the real one. Generic over the context and node
// types, so it needs no DOM types (the unit tests run in Node).
import type { NoiseSuppression } from './settings.js';

/** The suppressors that run as AudioWorklets in WebAssembly. */
export type WasmSuppressor = 'rnnoise' | 'speex' | 'gtcrn';

export function isWasmSuppressor(mode: NoiseSuppression): mode is WasmSuppressor {
  return mode === 'rnnoise' || mode === 'speex' || mode === 'gtcrn';
}

/**
 * The voice AudioContext's rate. RNNoise works on 480-sample frames of 48 kHz audio and does
 * not resample; GTCRN runs at 16 or 48 kHz only (and is silent at any other rate). Chromium
 * converts the microphone to the context's rate.
 */
export const VOICE_SAMPLE_RATE = 48_000;

/** Whether `kind` works at `sampleRate` (Speex adapts to any rate). */
export function supportsSampleRate(kind: WasmSuppressor, sampleRate: number): boolean {
  if (kind === 'rnnoise') return sampleRate === 48_000;
  if (kind === 'gtcrn') return sampleRate === 48_000 || sampleRate === 16_000;
  return true;
}

export interface CaptureProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceIsolation: boolean;
}

/**
 * What the microphone is asked for with `mode` in use (§2): echo cancellation and gain
 * control always; the browser's noise suppression only in the WebRTC mode, so the audio is
 * never cleaned twice.
 */
export function captureFor(mode: NoiseSuppression): CaptureProcessing {
  return { echoCancellation: true, noiseSuppression: mode === 'webrtc', autoGainControl: true, voiceIsolation: false };
}

/** What the loader reads of an AudioContext. */
export interface SuppressorContext {
  readonly sampleRate: number;
}

/** A suppressor in the audio graph (an AudioNode in the app). destroy() disconnects it and frees its WebAssembly state. */
export interface SuppressorNode<N = unknown> {
  readonly node: N;
  destroy(): void;
}

export interface SuppressorBackend<C extends SuppressorContext, N> {
  /** The suppressor's WebAssembly, fetched and compiled (a file that does not compile rejects). */
  load(kind: WasmSuppressor): Promise<ArrayBuffer>;
  /** Adds the suppressor's AudioWorklet module to `ctx`. */
  addModule(ctx: C, kind: WasmSuppressor): Promise<void>;
  /** A new mono suppressor node in `ctx`; `onError` runs if its processor fails while running. */
  createNode(ctx: C, kind: WasmSuppressor, wasm: ArrayBuffer, onError: () => void): SuppressorNode<N>;
}

export interface ResolvedSuppression<N = unknown> {
  /** The mode really in use: the chosen one, or 'webrtc' when its suppressor could not load. */
  mode: NoiseSuppression;
  /** The node to put between the microphone and the gate (the WebAssembly modes only). */
  suppressor: SuppressorNode<N> | null;
}

/** The part of an AudioNode the wiring uses. */
export interface Wirable<N> {
  connect(destination: N): unknown;
  disconnect(): void;
}

/**
 * The microphone end of an audio graph: source → [suppressor] → outputs (the gate's analyser
 * and gain, or the meter's analyser). The suppressor can be swapped while audio flows; every
 * swap rewires in one go and the outputs stay the only way on, so whatever comes after them
 * (the gate) is never bypassed. The chain owns its suppressor.
 */
export class SuppressorChain<N extends Wirable<N>> {
  #source: N | null = null;
  #outputs: readonly N[] = [];
  #suppressor: SuppressorNode<N> | null;

  constructor(suppressor: SuppressorNode<N> | null = null) {
    this.#suppressor = suppressor;
  }

  get suppressor(): SuppressorNode<N> | null {
    return this.#suppressor;
  }

  /** Feeds `outputs` from `source` through the suppressor (a new source after a device switch). */
  attach(source: N, outputs: readonly N[]): void {
    this.detach();
    this.#source = source;
    this.#outputs = outputs;
    this.#wire();
  }

  /** Disconnects the source and the suppressor's outputs; the suppressor stays for the next attach. */
  detach(): void {
    this.#source?.disconnect();
    this.#suppressor?.node.disconnect();
    this.#source = null;
    this.#outputs = [];
  }

  /** Puts `next` in place of the current suppressor, live, and destroys the previous one. */
  set(next: SuppressorNode<N> | null): void {
    const previous = this.#suppressor;
    if (next === previous) return;
    this.#suppressor = next;
    if (this.#source) {
      this.#source.disconnect();
      previous?.node.disconnect();
      this.#wire();
    }
    previous?.destroy();
  }

  destroy(): void {
    this.detach();
    this.#suppressor?.destroy();
    this.#suppressor = null;
  }

  #wire(): void {
    const source = this.#source;
    if (!source) return;
    let input = source;
    if (this.#suppressor) {
      source.connect(this.#suppressor.node);
      input = this.#suppressor.node;
    }
    for (const output of this.#outputs) input.connect(output);
  }
}

/**
 * Loads each suppressor on first use and keeps it: the WebAssembly once per app, the worklet
 * module once per AudioContext. A suppressor that fails (no AudioWorklet, WebAssembly that
 * does not compile, an unsupported rate, a processor error) is replaced by the browser's own
 * suppression for the rest of the session; the saved choice does not change (§2).
 */
export class NoiseSuppressors<C extends SuppressorContext & object, N> {
  readonly #backend: SuppressorBackend<C, N>;
  readonly #onFailed: (kind: WasmSuppressor) => void;
  readonly #wasm = new Map<WasmSuppressor, Promise<ArrayBuffer>>();
  readonly #modules = new WeakMap<C, Map<WasmSuppressor, Promise<void>>>();
  readonly #failed = new Set<WasmSuppressor>();

  constructor(backend: SuppressorBackend<C, N>, onFailed: (kind: WasmSuppressor) => void = () => {}) {
    this.#backend = backend;
    this.#onFailed = onFailed;
  }

  /** Whether `kind` failed in this session. */
  failed(kind: NoiseSuppression): boolean {
    return isWasmSuppressor(kind) && this.#failed.has(kind);
  }

  /** The mode that choosing `mode` puts in use now (without loading anything). */
  inUse(mode: NoiseSuppression): NoiseSuppression {
    return this.failed(mode) ? 'webrtc' : mode;
  }

  /** The suppressor for `mode` in `ctx`, loading it if needed; never rejects. */
  async resolve(mode: NoiseSuppression, ctx: C): Promise<ResolvedSuppression<N>> {
    if (!isWasmSuppressor(mode)) return { mode, suppressor: null };
    if (this.#failed.has(mode)) return { mode: 'webrtc', suppressor: null };
    try {
      if (!supportsSampleRate(mode, ctx.sampleRate)) throw new Error(`${mode} does not run at ${ctx.sampleRate} Hz`);
      const wasm = await this.#load(mode);
      await this.#addModule(ctx, mode);
      if (this.#failed.has(mode)) return { mode: 'webrtc', suppressor: null };
      return { mode, suppressor: this.#backend.createNode(ctx, mode, wasm, () => this.#fail(mode)) };
    } catch {
      this.#fail(mode);
      return { mode: 'webrtc', suppressor: null };
    }
  }

  #load(kind: WasmSuppressor): Promise<ArrayBuffer> {
    let wasm = this.#wasm.get(kind);
    if (!wasm) {
      wasm = this.#backend.load(kind);
      this.#wasm.set(kind, wasm);
    }
    return wasm;
  }

  #addModule(ctx: C, kind: WasmSuppressor): Promise<void> {
    let modules = this.#modules.get(ctx);
    if (!modules) {
      modules = new Map();
      this.#modules.set(ctx, modules);
    }
    let added = modules.get(kind);
    if (!added) {
      added = this.#backend.addModule(ctx, kind);
      modules.set(kind, added);
    }
    return added;
  }

  #fail(kind: WasmSuppressor): void {
    if (this.#failed.has(kind)) return;
    this.#failed.add(kind);
    this.#onFailed(kind);
  }
}
