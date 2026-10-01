// The real SuppressorBackend: @sapphi-red/web-noise-suppressor's AudioWorklets. Their scripts
// and WebAssembly ship inside the app (Vite `?url` assets under app://ghostlink); nothing is
// downloaded (noise suppression spec 2026-10-01 §1, §3).
import { GtcrnWorkletNode, RnnoiseWorkletNode, SpeexWorkletNode, loadGtcrn, loadRnnoise, loadSpeex } from '@sapphi-red/web-noise-suppressor';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import speexWasm from '@sapphi-red/web-noise-suppressor/speex.wasm?url';
import speexWorklet from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url';
import type { SuppressorBackend, WasmSuppressor } from './noiseSuppression.js';
import workletPorts from './workletPorts.js?url';

const WORKLETS: Readonly<Record<WasmSuppressor, string>> = { rnnoise: rnnoiseWorklet, speex: speexWorklet, gtcrn: gtcrnWorklet };

/** workletPorts.js, once per context and before any suppressor (so destroy() works). */
const portsReady = new WeakMap<AudioContext, Promise<void>>();

function fetchWasm(kind: WasmSuppressor): Promise<ArrayBuffer> {
  // RNNoise picks its SIMD build when the processor has it.
  if (kind === 'rnnoise') return loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
  if (kind === 'speex') return loadSpeex({ url: speexWasm });
  return loadGtcrn({ url: gtcrnWasm });
}

function workletNode(ctx: AudioContext, kind: WasmSuppressor, wasmBinary: ArrayBuffer) {
  const options = { maxChannels: 1, wasmBinary };
  if (kind === 'rnnoise') return new RnnoiseWorkletNode(ctx, options);
  if (kind === 'speex') return new SpeexWorkletNode(ctx, options);
  return new GtcrnWorkletNode(ctx, options);
}

export const webNoiseBackend: SuppressorBackend<AudioContext, AudioNode> = {
  async load(kind) {
    const wasm = await fetchWasm(kind);
    // The loaders do not check the response: a missing file would be app://'s index.html.
    // Compiling here turns that (or a damaged file) into a load failure instead of a
    // worklet that stays silent.
    await WebAssembly.compile(wasm);
    return wasm;
  },
  async addModule(ctx, kind) {
    let ports = portsReady.get(ctx);
    if (!ports) {
      ports = ctx.audioWorklet.addModule(workletPorts);
      portsReady.set(ctx, ports);
    }
    await ports;
    await ctx.audioWorklet.addModule(WORKLETS[kind]);
  },
  createNode(ctx, kind, wasm, onError) {
    const node = workletNode(ctx, kind, wasm);
    // One channel in and out: a stereo microphone is mixed down instead of leaving the
    // second channel silent (the processors fill only `maxChannels` channels).
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
    node.addEventListener('processorerror', onError);
    let destroyed = false;
    return {
      node,
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        node.removeEventListener('processorerror', onError);
        node.disconnect();
        node.destroy();
        node.port.close();
      },
    };
  },
};
