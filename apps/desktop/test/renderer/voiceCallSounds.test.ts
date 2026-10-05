// The call sounds (v0.5.2, spec 2026-10-02-sons-da-chamada-e-cookies-do-dj §1): which change of the
// voice store plays which sound, a full room plays one, a reconnect no flood, the switch off nothing.
import { describe, expect, it } from 'vitest';
import type { VoiceParticipant } from '@ghostlink/shared';
import { CALL_SOUND_TONES, CallSoundWatcher, SETTLE_MS, soundLength, type CallSound } from '../../src/renderer/features/voice/callSounds.js';
import { initialVoiceState, voiceReducer, type VoiceAction, type VoiceState } from '../../src/renderer/features/voice/state.js';

const ME = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
const CAIO = 'c'.repeat(32);
const DJ = 'd'.repeat(32);
const EVA = 'e'.repeat(32);
const SALA = 'VC1';
const OUTRA = 'VC2';
const p = (userId: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  serverMuted: false,
  serverDeafened: false,
  ...extra,
});

/** A voice store driven by its reducer, a watcher on it and a clock. */
function call(o: { enabled?: boolean; room?: VoiceParticipant[] } = {}) {
  let state: VoiceState = voiceReducer(initialVoiceState, {
    type: 'welcome',
    welcome: { serverId: 's1', self: { userId: ME, nickname: 'Eu', isOwner: false }, features: ['voice'], voice: o.room ? [{ channelId: SALA, participants: o.room }] : [] },
  });
  const played: CallSound[] = [];
  const clock = { now: 1_000 };
  const watcher = new CallSoundWatcher(state, { play: (s) => played.push(s), enabled: () => o.enabled ?? true, now: () => clock.now });
  /** Applies the actions as one burst (one task), then moves the clock on. */
  const step = (...actions: VoiceAction[]) => {
    for (const a of actions) state = voiceReducer(state, a);
    watcher.update(state);
    clock.now += 500;
  };
  const room = (participants: VoiceParticipant[], channelId = SALA): VoiceAction => ({ type: 'serverEvent', event: { t: 'voice.state', d: { channelId, participants } } });
  const status = (s: VoiceState['call']['status'], channelId: string | null = SALA): VoiceAction => ({ type: 'call', status: s, channelId: s === 'idle' ? null : channelId });
  /** Takes what played since the last call. */
  const heard = () => played.splice(0);
  return { step, room, status, heard, watcher, clock };
}

describe('call sounds', () => {
  it('each sound is short: at most 400 ms', () => {
    for (const sound of Object.keys(CALL_SOUND_TONES) as CallSound[]) expect(soundLength(sound), sound).toBeLessThanOrEqual(0.4);
  });

  it('plays join and leave for me and for anyone in my room, bots too; joining a full room plays one sound', () => {
    const c = call({ room: [p(BIA), p(CAIO)] });
    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(CAIO), p(ME)]));
    expect(c.heard()).toEqual(['join']);

    c.step(c.room([p(BIA), p(CAIO), p(ME), p(DJ)]));
    expect(c.heard()).toEqual(['join']);
    c.step(c.room([p(BIA), p(ME), p(DJ)]));
    expect(c.heard()).toEqual(['leave']);
    // Another channel of the server is not my room.
    c.step(c.room([p(CAIO)], OUTRA));
    expect(c.heard()).toEqual([]);

    // Moving to another channel plays join; leaving (asked for) plays leave.
    c.step(c.status('connecting', OUTRA));
    c.step(c.status('connected', OUTRA), c.room([p(CAIO), p(ME)], OUTRA));
    expect(c.heard()).toEqual(['join']);
    c.watcher.expectLeave();
    c.step(c.status('idle'));
    expect(c.heard()).toEqual(['leave']);
  });

  it('a call that ends without my asking plays disconnected', () => {
    const c = call({ room: [p(BIA)] });
    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(ME)]));
    c.heard();
    c.step(c.status('reconnecting'));
    c.step(c.status('idle'), { type: 'notice', notice: { kind: 'dropped' } });
    expect(c.heard()).toEqual(['disconnected']);
    // A join that never connected plays nothing.
    c.step(c.status('connecting'));
    c.step(c.status('idle'));
    expect(c.heard()).toEqual([]);
  });

  it('plays mute and deafen for mine and a moderator’s; deafening, which also mutes, plays deafen only', () => {
    const c = call({ room: [p(BIA)] });
    c.step({ type: 'self', muted: true });
    c.step({ type: 'self', muted: false });
    expect(c.heard()).toEqual(['mute', 'unmute']);
    c.step({ type: 'self', deafened: true });
    c.step({ type: 'self', muted: false, deafened: false });
    expect(c.heard()).toEqual(['deafen', 'undeafen']);

    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(ME)]));
    c.heard();
    c.step(c.room([p(BIA), p(ME, { serverMuted: true })]));
    c.step(c.room([p(BIA), p(ME)]));
    c.step(c.room([p(BIA), p(ME, { serverMuted: true, serverDeafened: true })]));
    expect(c.heard()).toEqual(['mute', 'unmute', 'deafen']);
    // Muting myself while the moderator's mute holds changes nothing I hear.
    c.step({ type: 'self', muted: true });
    expect(c.heard()).toEqual([]);
  });

  it('plays a screen share starting and stopping in my room, mine too', () => {
    const c = call({ room: [p(BIA)] });
    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(ME)]));
    c.heard();
    c.step(c.room([p(BIA, { screen: true }), p(ME)]));
    c.step(c.room([p(BIA, { screen: true }), p(ME, { screen: true })]));
    c.step(c.room([p(BIA), p(ME, { screen: true })]));
    expect(c.heard()).toEqual(['streamStart', 'streamStart', 'streamStop']);
    // Someone leaving while sharing just leaves.
    c.step(c.room([p(BIA, { screen: true }), p(ME, { screen: true })]));
    c.heard();
    c.step(c.room([p(ME, { screen: true })]));
    expect(c.heard()).toEqual(['leave']);
  });

  it('a reconnect plays nobody’s join, and the same sound within 150 ms plays once', () => {
    const c = call({ room: [p(BIA), p(CAIO)] });
    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(CAIO), p(ME)]));
    c.heard();
    // LiveKit reconnects: the room comes back in pieces.
    c.step(c.status('reconnecting'), c.room([p(BIA), p(CAIO)]));
    c.step(c.status('connected'), c.room([p(ME)]));
    c.step(c.room([p(BIA), p(ME)]));
    c.step(c.room([p(BIA), p(CAIO), p(ME)]));
    expect(c.heard()).toEqual([]);
    // The call's server reconnects: its welcome brings the room back, then the events.
    c.watcher.settle();
    c.step({ type: 'serverEvent', serverId: 's1', event: { t: 'welcome', d: { serverId: 's1', self: { userId: ME }, features: ['voice'], voice: [{ channelId: SALA, participants: [p(ME)] }] } } });
    c.step(c.room([p(BIA), p(CAIO), p(ME)]));
    expect(c.heard()).toEqual([]);

    // Settled: a real join plays again; another 100 ms later does not.
    c.clock.now += SETTLE_MS;
    const at = c.clock.now;
    c.step(c.room([p(BIA), p(CAIO), p(ME), p(DJ)]));
    c.clock.now = at + 100;
    c.step(c.room([p(BIA), p(CAIO), p(ME), p(DJ), p(EVA)]));
    expect(c.heard()).toEqual(['join']);
  });

  it('with the switch off, nothing plays', () => {
    const c = call({ enabled: false, room: [p(BIA)] });
    c.step(c.status('connecting'));
    c.step(c.status('connected'), c.room([p(BIA), p(ME)]));
    c.step({ type: 'self', muted: true });
    c.step(c.room([p(BIA, { screen: true }), p(ME)]));
    c.step(c.status('idle'));
    expect(c.heard()).toEqual([]);
  });
});
