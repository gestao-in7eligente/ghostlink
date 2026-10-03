// The call sounds (v0.5.2, spec 2026-10-02-sons-da-chamada-e-cookies-do-dj-design.md §1), pure:
// what each sound is made of, and which ones a change of the voice store plays. GhostLink's own
// short chimes in Discord's style (never Discord's files); callSoundPlayer.ts plays them.
import { participantsOf, selfVoice, type VoiceState } from './state.js';

export type CallSound = 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'streamStart' | 'streamStop' | 'disconnected';

/** One note: a sine (with a soft octave above) from `at` for `dur` seconds, gliding to `to` Hz when set. */
export interface CallTone {
  freq: number;
  at: number;
  dur: number;
  to?: number;
}

const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const F5 = 698.46;
const G5 = 783.99;
const A5 = 880;
const BB4 = 466.16;
const EB5 = 622.25;
const G3 = 196;

/** Each sound's notes: rising when something starts, falling when it ends; at most 400 ms each. */
export const CALL_SOUND_TONES: Readonly<Record<CallSound, readonly CallTone[]>> = {
  // Two notes up / down.
  join: [
    { freq: D5, at: 0, dur: 0.16 },
    { freq: A5, at: 0.11, dur: 0.26 },
  ],
  leave: [
    { freq: A5, at: 0, dur: 0.16 },
    { freq: D5, at: 0.11, dur: 0.26 },
  ],
  // A short tap, down to mute and up to unmute; deafening is the same a whole tone lower.
  mute: [
    { freq: F5, at: 0, dur: 0.09 },
    { freq: C5, at: 0.07, dur: 0.14 },
  ],
  unmute: [
    { freq: C5, at: 0, dur: 0.09 },
    { freq: F5, at: 0.07, dur: 0.14 },
  ],
  deafen: [
    { freq: EB5, at: 0, dur: 0.09 },
    { freq: BB4, at: 0.07, dur: 0.14 },
  ],
  undeafen: [
    { freq: BB4, at: 0, dur: 0.09 },
    { freq: EB5, at: 0.07, dur: 0.14 },
  ],
  // Three notes up / down.
  streamStart: [
    { freq: C5, at: 0, dur: 0.12 },
    { freq: E5, at: 0.09, dur: 0.12 },
    { freq: G5, at: 0.18, dur: 0.2 },
  ],
  streamStop: [
    { freq: G5, at: 0, dur: 0.12 },
    { freq: E5, at: 0.09, dur: 0.12 },
    { freq: C5, at: 0.18, dur: 0.2 },
  ],
  // One longer fall.
  disconnected: [{ freq: E5, to: G3, at: 0, dur: 0.4 }],
};

/** How long a sound lasts (s). */
export function soundLength(sound: CallSound): number {
  return Math.max(...CALL_SOUND_TONES[sound].map((t) => t.at + t.dur));
}

/** The same sound again within this long plays once. */
export const DEDUPE_MS = 150;
/**
 * After a reconnect (LiveKit's, or the call's server's connection with its new welcome), who is
 * in the room settles for this long without a sound: it is not everyone joining again.
 */
export const SETTLE_MS = 3_000;

export interface CallSoundDeps {
  play(sound: CallSound): void;
  /** "Sons da chamada" in Configurações → Voz. */
  enabled(): boolean;
  now(): number;
}

type Call = VoiceState['call'];

const inCall = (call: Call): boolean => call.status === 'connected' || call.status === 'reconnecting';

/** Both states are connected to the same channel: what changed there happened in my room. */
function sameRoom(a: VoiceState, b: VoiceState): boolean {
  return a.call.status === 'connected' && b.call.status === 'connected' && a.call.channelId === b.call.channelId && a.serverId === b.serverId;
}

/** My microphone is off: by me, by deafening, or (`server`) by a moderator. */
function micOff(s: VoiceState, server: boolean): boolean {
  return s.selfMuted || s.selfDeafened || (server && selfVoice(s)?.serverMuted === true);
}

function soundOff(s: VoiceState, server: boolean): boolean {
  return s.selfDeafened || (server && selfVoice(s)?.serverDeafened === true);
}

/**
 * Follows the voice store and plays the call sounds (spec §1):
 * - join and leave: me, and anyone (bots too) in the room I am in; joining a room with people
 *   in it plays my join only, and moving to another channel plays join;
 * - mute/unmute and deafen/undeafen of my microphone and sound, by me or by a moderator
 *   (deafening, which also mutes, plays deafen only);
 * - a screen share starting or stopping in my room, mine too;
 * - disconnected when the call ends without my asking (expectLeave() marks a leave I asked for).
 * The same sound within 150 ms plays once, and a reconnect plays nobody's join.
 * `update()` takes the store after each burst of changes (the runtime batches them per task).
 */
export class CallSoundWatcher {
  readonly #deps: CallSoundDeps;
  #prev: VoiceState;
  #leaving = false;
  #quietUntil = Number.NEGATIVE_INFINITY;
  readonly #last = new Map<CallSound, number>();

  constructor(initial: VoiceState, deps: CallSoundDeps) {
    this.#prev = initial;
    this.#deps = deps;
  }

  /** I asked to leave the call, or to move it: its end plays leave, not disconnected. */
  expectLeave(): void {
    this.#leaving = true;
  }

  /** The call's server connected again (a new welcome): who is in the room settles without sounds. */
  settle(): void {
    this.#quietUntil = this.#deps.now() + SETTLE_MS;
  }

  update(next: VoiceState): void {
    const prev = this.#prev;
    if (prev === next) return;
    this.#prev = next;
    const now = this.#deps.now();
    const sounds: CallSound[] = [];
    const was = prev.call;
    const is = next.call;

    // My call.
    if (is.status === 'connected' && was.status === 'reconnecting' && was.channelId === is.channelId) this.#quietUntil = now + SETTLE_MS;
    else if (is.status === 'connected' && (was.status !== 'connected' || was.channelId !== is.channelId)) sounds.push('join');
    else if (is.status === 'idle' && inCall(was)) sounds.push(this.#leaving ? 'leave' : 'disconnected');
    if (is.status === 'idle' || is.status === 'connected') this.#leaving = false;

    // My microphone and sound: a moderator's change counts while I stay in the same room.
    const room = sameRoom(prev, next);
    if (soundOff(prev, room) !== soundOff(next, room)) sounds.push(soundOff(next, room) ? 'deafen' : 'undeafen');
    else if (micOff(prev, room) !== micOff(next, room)) sounds.push(micOff(next, room) ? 'mute' : 'unmute');

    // My room: who comes and goes, whose screen goes live or ends.
    if (room && now >= this.#quietUntil) {
      const channelId = is.channelId!;
      const before = new Map(participantsOf(prev, channelId).map((p) => [p.userId, p]));
      const after = new Map(participantsOf(next, channelId).map((p) => [p.userId, p]));
      const self = next.selfUserId;
      for (const userId of after.keys()) if (!before.has(userId) && userId !== self) sounds.push('join');
      for (const userId of before.keys()) if (!after.has(userId) && userId !== self) sounds.push('leave');
      for (const [userId, p] of after) {
        const old = before.get(userId);
        if (old && old.screen !== p.screen) sounds.push(p.screen ? 'streamStart' : 'streamStop');
      }
    }

    if (sounds.length === 0 || !this.#deps.enabled()) return;
    for (const sound of new Set(sounds)) {
      const last = this.#last.get(sound);
      if (last !== undefined && now - last < DEDUPE_MS) continue;
      this.#last.set(sound, now);
      this.#deps.play(sound);
    }
  }
}
