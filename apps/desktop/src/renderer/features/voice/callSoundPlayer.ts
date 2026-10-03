// Plays the call sounds (callSounds.ts) with Web Audio: each note a sine with a soft octave above,
// a quick attack and an exponential fade, on an AudioContext of its own that follows the output
// device chosen in Configurações → Voz (AudioContext.setSinkId).
import { CALL_SOUND_TONES, type CallSound } from './callSounds.js';

/** The sounds' level: comfortably under a voice. */
const VOLUME = 0.16;
/** The octave above each note, for a rounder, bell-like tone. */
const OCTAVE = 0.12;
const ATTACK = 0.012;
const SILENT = 0.0001;

/** Chromium has AudioContext.setSinkId; TypeScript's DOM types do not yet. */
type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

let context: SinkableContext | null = null;
/** The output the context plays to now ('' = the system default), or null before the first sound. */
let sink: string | null = null;

/** Points the sounds at `deviceId` (null: the system default); a device that is gone falls back to the default. */
async function routeTo(ctx: SinkableContext, deviceId: string | null): Promise<void> {
  const want = deviceId ?? '';
  if (sink === want || !ctx.setSinkId) return;
  try {
    await ctx.setSinkId(want);
  } catch {
    await ctx.setSinkId('').catch(() => {});
  }
  sink = want;
}

/** Plays one call sound on the output device `deviceId` (null: the system default). Never throws. */
export async function playCallSound(sound: CallSound, deviceId: string | null): Promise<void> {
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' }) as SinkableContext;
    const ctx = context;
    await routeTo(ctx, deviceId);
    if (ctx.state === 'suspended') await ctx.resume();
    const start = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = VOLUME;
    out.connect(ctx.destination);
    let last: OscillatorNode | null = null;
    let end = 0;
    for (const tone of CALL_SOUND_TONES[sound]) {
      const from = start + tone.at;
      const to = from + tone.dur;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(SILENT, from);
      envelope.gain.exponentialRampToValueAtTime(1, from + ATTACK);
      envelope.gain.exponentialRampToValueAtTime(SILENT, to);
      envelope.connect(out);
      for (const [multiple, level] of [[1, 1], [2, OCTAVE]] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(tone.freq * multiple, from);
        if (tone.to !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.to * multiple, to);
        const gain = ctx.createGain();
        gain.gain.value = level;
        osc.connect(gain).connect(envelope);
        osc.start(from);
        osc.stop(to + 0.02);
        if (to >= end) {
          end = to;
          last = osc;
        }
      }
    }
    // The graph goes once the last note ended.
    if (last) last.onended = () => out.disconnect();
  } catch {
    // No audio device, or the context could not start: the call goes on without its sounds.
  }
}
