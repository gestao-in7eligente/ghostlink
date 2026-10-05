import { describe, expect, it } from 'vitest';
import {
  NoiseSuppressors,
  SuppressorChain,
  VOICE_SAMPLE_RATE,
  captureFor,
  isWasmSuppressor,
  supportsSampleRate,
  type SuppressorBackend,
  type SuppressorNode,
  type WasmSuppressor,
} from '../../src/renderer/features/voice/noiseSuppression.js';
import { NOISE_SUPPRESSIONS } from '../../src/renderer/features/voice/settings.js';

/** An audio node that records where it is connected. */
class FakeNode {
  readonly out = new Set<FakeNode>();
  constructor(readonly name: string) {}
  connect(to: FakeNode): void {
    this.out.add(to);
  }
  disconnect(): void {
    this.out.clear();
  }
}

const edges = (...nodes: FakeNode[]) => nodes.flatMap((n) => [...n.out].map((o) => `${n.name}→${o.name}`)).sort();

function fakeSuppressor(name: string): SuppressorNode<FakeNode> & { destroyed: number } {
  const node = new FakeNode(name);
  const s = {
    node,
    destroyed: 0,
    destroy: () => {
      s.destroyed++;
      node.disconnect();
    },
  };
  return s;
}

interface Ctx {
  sampleRate: number;
}

/** A backend that records calls; `fail` makes one step reject for a kind. */
function fakeBackend() {
  const calls: string[] = [];
  const fail: Partial<Record<WasmSuppressor, 'load' | 'addModule' | 'createNode'>> = {};
  const errors = new Map<string, () => void>();
  let gate: Promise<void> = Promise.resolve();
  const backend: SuppressorBackend<Ctx, FakeNode> & { calls: string[]; fail: typeof fail; errors: typeof errors; hold(p: Promise<void>): void } = {
    calls,
    fail,
    errors,
    hold: (p) => {
      gate = p;
    },
    async load(kind) {
      calls.push(`load:${kind}`);
      await gate;
      if (fail[kind] === 'load') throw new Error('CompileError');
      return new ArrayBuffer(8);
    },
    async addModule(ctx, kind) {
      calls.push(`addModule:${kind}@${ctx.sampleRate}`);
      if (fail[kind] === 'addModule') throw new Error('AbortError');
    },
    createNode(_ctx, kind, wasm, onError) {
      calls.push(`createNode:${kind}:${wasm.byteLength}`);
      if (fail[kind] === 'createNode') throw new Error('InvalidStateError');
      const s = fakeSuppressor(kind);
      errors.set(kind, onError);
      return s;
    },
  };
  return backend;
}

describe('what the microphone is asked for (noise spec §2)', () => {
  it('the browser cleans the sound only in the WebRTC mode; echo cancellation and gain control always', () => {
    const map = Object.fromEntries(NOISE_SUPPRESSIONS.map((m) => [m, captureFor(m)]));
    const rest = { echoCancellation: true, autoGainControl: true, voiceIsolation: false };
    expect(map).toEqual({
      rnnoise: { ...rest, noiseSuppression: false },
      speex: { ...rest, noiseSuppression: false },
      gtcrn: { ...rest, noiseSuppression: false },
      webrtc: { ...rest, noiseSuppression: true },
      off: { ...rest, noiseSuppression: false },
    });
  });

  it('three modes run a WebAssembly suppressor; the voice context runs at 48 kHz, where all of them work', () => {
    expect(NOISE_SUPPRESSIONS.filter(isWasmSuppressor)).toEqual(['rnnoise', 'speex', 'gtcrn']);
    expect(VOICE_SAMPLE_RATE).toBe(48_000);
    for (const kind of ['rnnoise', 'speex', 'gtcrn'] as const) expect(supportsSampleRate(kind, VOICE_SAMPLE_RATE), kind).toBe(true);
    // RNNoise has fixed 48 kHz frames; GTCRN is silent at anything but 16 or 48 kHz.
    expect(supportsSampleRate('rnnoise', 44_100)).toBe(false);
    expect(supportsSampleRate('gtcrn', 44_100)).toBe(false);
    expect(supportsSampleRate('gtcrn', 16_000)).toBe(true);
    expect(supportsSampleRate('speex', 44_100)).toBe(true);
  });
});

describe('choosing the suppressor node', () => {
  const ctx: Ctx = { sampleRate: 48_000 };

  it('WebRTC and Desativada put no node in the graph and load nothing', async () => {
    const backend = fakeBackend();
    const noise = new NoiseSuppressors(backend);
    expect(await noise.resolve('webrtc', ctx)).toEqual({ mode: 'webrtc', suppressor: null });
    expect(await noise.resolve('off', ctx)).toEqual({ mode: 'off', suppressor: null });
    expect(backend.calls).toEqual([]);
  });

  it('a WebAssembly mode gets its own node; the binary loads once per app, the worklet once per context', async () => {
    const backend = fakeBackend();
    const noise = new NoiseSuppressors(backend);
    const first = await noise.resolve('rnnoise', ctx);
    expect(first.mode).toBe('rnnoise');
    expect(first.suppressor?.node.name).toBe('rnnoise');
    const second = await noise.resolve('rnnoise', ctx);
    expect(second.suppressor).not.toBe(first.suppressor);
    const other: Ctx = { sampleRate: 48_000 };
    await noise.resolve('rnnoise', other);
    expect((await noise.resolve('speex', ctx)).suppressor?.node.name).toBe('speex');
    expect(backend.calls).toEqual([
      'load:rnnoise',
      'addModule:rnnoise@48000',
      'createNode:rnnoise:8',
      'createNode:rnnoise:8',
      'addModule:rnnoise@48000',
      'createNode:rnnoise:8',
      'load:speex',
      'addModule:speex@48000',
      'createNode:speex:8',
    ]);
  });

  it('two microphones asking at once share one load', async () => {
    const backend = fakeBackend();
    let release!: () => void;
    backend.hold(new Promise<void>((r) => (release = r)));
    const noise = new NoiseSuppressors(backend);
    const both = Promise.all([noise.resolve('gtcrn', ctx), noise.resolve('gtcrn', ctx)]);
    release();
    const [a, b] = await both;
    expect([a.mode, b.mode]).toEqual(['gtcrn', 'gtcrn']);
    expect(backend.calls.filter((c) => c.startsWith('load:'))).toEqual(['load:gtcrn']);
  });

  it.each(['load', 'addModule', 'createNode'] as const)('a failure to %s falls back to WebRTC for the session, once', async (step) => {
    const backend = fakeBackend();
    backend.fail.rnnoise = step;
    const failed: WasmSuppressor[] = [];
    const noise = new NoiseSuppressors(backend, (kind) => failed.push(kind));
    expect(await noise.resolve('rnnoise', ctx)).toEqual({ mode: 'webrtc', suppressor: null });
    expect(noise.failed('rnnoise')).toBe(true);
    expect(noise.inUse('rnnoise')).toBe('webrtc');
    expect(failed).toEqual(['rnnoise']);
    // Not retried in this session, and no second notice.
    const calls = backend.calls.length;
    expect(await noise.resolve('rnnoise', ctx)).toEqual({ mode: 'webrtc', suppressor: null });
    expect(backend.calls.length).toBe(calls);
    expect(failed).toEqual(['rnnoise']);
    // The other suppressors still work.
    expect((await noise.resolve('speex', ctx)).mode).toBe('speex');
    expect(noise.failed('speex')).toBe(false);
    expect(noise.inUse('off')).toBe('off');
  });

  it('a context at a rate the suppressor cannot use falls back without loading it', async () => {
    const backend = fakeBackend();
    const failed: WasmSuppressor[] = [];
    const noise = new NoiseSuppressors(backend, (kind) => failed.push(kind));
    expect(await noise.resolve('gtcrn', { sampleRate: 44_100 })).toEqual({ mode: 'webrtc', suppressor: null });
    expect(failed).toEqual(['gtcrn']);
    expect(backend.calls).toEqual([]);
    expect((await noise.resolve('speex', { sampleRate: 44_100 })).mode).toBe('speex');
  });

  it('a processor that breaks while running marks its suppressor failed', async () => {
    const backend = fakeBackend();
    const failed: WasmSuppressor[] = [];
    const noise = new NoiseSuppressors(backend, (kind) => failed.push(kind));
    expect((await noise.resolve('speex', ctx)).mode).toBe('speex');
    backend.errors.get('speex')!();
    backend.errors.get('speex')!();
    expect(failed).toEqual(['speex']);
    expect(noise.inUse('speex')).toBe('webrtc');
    expect(await noise.resolve('speex', ctx)).toEqual({ mode: 'webrtc', suppressor: null });
  });
});

describe('the suppressor in front of the gate (live switching never bypasses it)', () => {
  const graph = () => ({ mic: new FakeNode('mic'), analyser: new FakeNode('analyser'), gain: new FakeNode('gain') });

  it('microphone → suppressor → analyser and gain; swaps rewire it and destroy the previous one', () => {
    const { mic, analyser, gain } = graph();
    const rnnoise = fakeSuppressor('rnnoise');
    const chain = new SuppressorChain<FakeNode>(rnnoise);
    chain.attach(mic, [analyser, gain]);
    expect(edges(mic, rnnoise.node)).toEqual(['mic→rnnoise', 'rnnoise→analyser', 'rnnoise→gain']);

    const speex = fakeSuppressor('speex');
    chain.set(speex);
    expect(edges(mic, rnnoise.node, speex.node)).toEqual(['mic→speex', 'speex→analyser', 'speex→gain']);
    expect(rnnoise.destroyed).toBe(1);

    chain.set(null); // WebRTC or Desativada
    expect(edges(mic, speex.node)).toEqual(['mic→analyser', 'mic→gain']);
    expect(speex.destroyed).toBe(1);

    const gtcrn = fakeSuppressor('gtcrn');
    chain.set(gtcrn);
    expect(edges(mic, gtcrn.node)).toEqual(['gtcrn→analyser', 'gtcrn→gain', 'mic→gtcrn']);
    chain.set(gtcrn);
    expect(gtcrn.destroyed).toBe(0);
  });

  it('a new microphone (device switch) goes through the same suppressor; destroy frees it', () => {
    const { mic, analyser, gain } = graph();
    const rnnoise = fakeSuppressor('rnnoise');
    const chain = new SuppressorChain<FakeNode>(rnnoise);
    chain.attach(mic, [analyser, gain]);
    chain.detach();
    expect(edges(mic, rnnoise.node)).toEqual([]);
    const mic2 = new FakeNode('mic2');
    chain.attach(mic2, [analyser, gain]);
    expect(edges(mic, mic2, rnnoise.node)).toEqual(['mic2→rnnoise', 'rnnoise→analyser', 'rnnoise→gain']);
    expect(rnnoise.destroyed).toBe(0);
    chain.destroy();
    expect(edges(mic2, rnnoise.node)).toEqual([]);
    expect(rnnoise.destroyed).toBe(1);
    expect(chain.suppressor).toBeNull();
  });

  it('a swap before the microphone opens only replaces the node', () => {
    const first = fakeSuppressor('rnnoise');
    const chain = new SuppressorChain<FakeNode>(first);
    const next = fakeSuppressor('speex');
    chain.set(next);
    expect(first.destroyed).toBe(1);
    expect(chain.suppressor).toBe(next);
    const { mic, analyser } = graph();
    chain.attach(mic, [analyser]);
    expect(edges(mic, next.node)).toEqual(['mic→speex', 'speex→analyser']);
  });
});
