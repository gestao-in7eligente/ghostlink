import { describe, expect, it } from 'vitest';
import type { VoiceParticipant } from '@ghostlink/shared';
import { initialVoiceState, isSpeaking, liveIn, participantsOf, selfVoice, streamLayout, voiceReducer, type VoiceState } from '../../src/renderer/features/voice/state.js';

const ANA = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
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
const welcome = (voice: unknown, serverId = 's1', userId = ANA) => ({ serverId, self: { userId, nickname: 'Ana', isOwner: false }, voice });

function run(...actions: Parameters<typeof voiceReducer>[1][]): VoiceState {
  return actions.reduce(voiceReducer, initialVoiceState);
}

describe('voice store reducer', () => {
  it('takes the voice snapshot from the welcome', () => {
    const s = run({ type: 'welcome', welcome: welcome([{ channelId: 'VC1', participants: [p(BIA)] }]) });
    expect(s.serverId).toBe('s1');
    expect(s.selfUserId).toBe(ANA);
    expect(participantsOf(s, 'VC1')).toEqual([p(BIA)]);
    expect(participantsOf(s, 'VC2')).toEqual([]);
  });

  it('a welcome without a usable voice field means nobody in voice (lenient, spec §5.1)', () => {
    for (const voice of [undefined, null, 'x', [{ channelId: 'VC1', participants: [{ userId: 'nope' }] }]]) {
      expect(run({ type: 'welcome', welcome: welcome(voice) }).channels).toEqual({});
    }
  });

  it('voice.state replaces one channel; an empty list removes it; unknown fields are dropped', () => {
    let s = run({ type: 'welcome', welcome: welcome([{ channelId: 'VC1', participants: [p(BIA)] }]) });
    s = voiceReducer(s, { type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC2', participants: [{ ...p(ANA), extra: 1 }] } } });
    expect(participantsOf(s, 'VC2')).toEqual([p(ANA)]);
    expect(participantsOf(s, 'VC1')).toEqual([p(BIA)]);
    s = voiceReducer(s, { type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [] } } });
    expect(Object.keys(s.channels)).toEqual(['VC2']);
  });

  it('ignores malformed voice.state and unrelated events', () => {
    const s = run({ type: 'welcome', welcome: welcome([{ channelId: 'VC1', participants: [p(BIA)] }]) });
    for (const event of [
      { t: 'voice.state', d: { channelId: 'VC1' } },
      { t: 'voice.state', d: { channelId: '../x', participants: [] } },
      { t: 'voice.state' },
      { t: 'msg.new', d: { channelId: 'VC1' } },
    ]) {
      expect(voiceReducer(s, { type: 'serverEvent', event })).toBe(s);
    }
  });

  it('a reconnect welcome replaces the whole map; leaving the server resets everything', () => {
    let s = run({ type: 'welcome', welcome: welcome([{ channelId: 'VC1', participants: [p(BIA)] }]) }, { type: 'call', status: 'connected', channelId: 'VC1' });
    s = voiceReducer(s, { type: 'serverEvent', event: { t: 'welcome', d: welcome([{ channelId: 'VC2', participants: [p(ANA)] }]) } });
    expect(Object.keys(s.channels)).toEqual(['VC2']);
    expect(s.call).toEqual({ status: 'connected', channelId: 'VC1' });
    s = voiceReducer(s, { type: 'reset' });
    expect(s).toEqual({ ...initialVoiceState, selfMuted: s.selfMuted, selfDeafened: s.selfDeafened });
  });

  it('voice is available when the welcome lists it, then follows voice.availability live', () => {
    const withFeatures = (features: unknown) => ({ ...welcome([]), features });
    const availability = (d: unknown) => ({ type: 'serverEvent' as const, event: { t: 'voice.availability', d } });
    expect(initialVoiceState.available).toBe(false);
    let s = run({ type: 'welcome', welcome: withFeatures([]) });
    expect(s.available).toBe(false);
    s = voiceReducer(s, availability({ available: true }));
    expect(s.available).toBe(true);
    expect(voiceReducer(s, availability({ available: true }))).toBe(s); // unchanged: no re-render
    s = voiceReducer(s, availability({ available: false }));
    expect(s.available).toBe(false);
    // A reconnect welcome is the new truth; leaving the server forgets it.
    s = voiceReducer(s, { type: 'serverEvent', event: { t: 'welcome', d: withFeatures(['text', 'voice']) } });
    expect(s.available).toBe(true);
    expect(voiceReducer(s, { type: 'reset' }).available).toBe(false);
    for (const features of [undefined, 'voice', [1]]) expect(run({ type: 'welcome', welcome: withFeatures(features) }).available).toBe(false);
  });

  it('ignores a malformed voice.availability', () => {
    const s = run({ type: 'welcome', welcome: { ...welcome([]), features: ['voice'] } });
    for (const d of [undefined, null, {}, { available: 'no' }, { available: 0 }]) {
      expect(voiceReducer(s, { type: 'serverEvent', event: { t: 'voice.availability', d } })).toBe(s);
    }
  });

  it('knows my own entry (server mute) in the channel I am in', () => {
    let s = run({ type: 'welcome', welcome: welcome([]) }, { type: 'call', status: 'connected', channelId: 'VC1' });
    expect(selfVoice(s)).toBeNull();
    s = voiceReducer(s, { type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [p(ANA, { serverMuted: true })] } } });
    expect(selfVoice(s)?.serverMuted).toBe(true);
  });

  it('tracks speaking and subscribed users of my room, cleared when the call ends', () => {
    let s = run(
      { type: 'call', status: 'connected', channelId: 'VC1' },
      { type: 'speaking', userIds: [BIA, ANA] },
      { type: 'subscribed', userId: BIA, subscribed: true },
      { type: 'ping', ms: 42 },
    );
    expect(s.speaking).toEqual([BIA, ANA]);
    expect(s.subscribed).toEqual([BIA]);
    expect(s.pingMs).toBe(42);
    s = voiceReducer(s, { type: 'subscribed', userId: BIA, subscribed: false });
    expect(s.subscribed).toEqual([]);
    s = voiceReducer(s, { type: 'speaking', userIds: [BIA] });
    s = voiceReducer(s, { type: 'call', status: 'idle', channelId: null });
    expect(s.speaking).toEqual([]);
    expect(s.pingMs).toBeNull();
  });

  it('my ring follows my own gate at once; others follow LiveKit', () => {
    let s = run({ type: 'welcome', welcome: welcome([]) }, { type: 'call', status: 'connected', channelId: 'VC1' });
    expect(isSpeaking(s, ANA)).toBe(false);
    s = voiceReducer(s, { type: 'transmitting', open: true });
    expect(isSpeaking(s, ANA)).toBe(true);
    expect(isSpeaking(s, BIA)).toBe(false);
    s = voiceReducer(s, { type: 'speaking', userIds: [BIA] });
    expect(isSpeaking(s, BIA)).toBe(true);
    s = voiceReducer(s, { type: 'call', status: 'idle', channelId: null });
    expect([s.transmitting, isSpeaking(s, ANA)]).toEqual([false, false]);
  });

  it('keeps the names LiveKit reports, merged', () => {
    const s = run({ type: 'names', names: { [ANA]: 'Ana' } }, { type: 'names', names: { [BIA]: 'Bia' } });
    expect(s.names).toEqual({ [ANA]: 'Ana', [BIA]: 'Bia' });
  });

  it('self mute and deafen, and notices', () => {
    let s = run({ type: 'self', muted: true });
    expect([s.selfMuted, s.selfDeafened]).toEqual([true, false]);
    s = voiceReducer(s, { type: 'self', deafened: true });
    expect([s.selfMuted, s.selfDeafened]).toEqual([true, true]);
    s = voiceReducer(s, { type: 'notice', notice: { kind: 'error', code: 'CHANNEL_FULL' } });
    expect(s.notice).toEqual({ kind: 'error', code: 'CHANNEL_FULL' });
    s = voiceReducer(s, { type: 'notice', notice: null });
    expect(s.notice).toBeNull();
  });
});

describe('screen sharing in the voice store (spec 2026-10-01 §5)', () => {
  const sharing = { quality: '1080p30' as const, content: 'motion' as const, audio: true, name: 'Tela 1' };

  it('keeps my own share while it is live', () => {
    let s = run({ type: 'call', status: 'connected', channelId: 'VC1' }, { type: 'sharing', sharing });
    expect(s.sharing).toEqual(sharing);
    s = voiceReducer(s, { type: 'sharing', sharing: null });
    expect(s.sharing).toBeNull();
  });

  it('"Parar de assistir" adds once to the unwatched set, "Assistir" removes', () => {
    let s = run({ type: 'call', status: 'connected', channelId: 'VC1' }, { type: 'watch', userId: BIA, watching: false });
    expect(s.unwatched).toEqual([BIA]);
    expect(voiceReducer(s, { type: 'watch', userId: BIA, watching: false })).toBe(s); // no re-render
    s = voiceReducer(s, { type: 'watch', userId: ANA, watching: false });
    expect(s.unwatched).toEqual([BIA, ANA]);
    s = voiceReducer(s, { type: 'watch', userId: BIA, watching: true });
    expect(s.unwatched).toEqual([ANA]);
    expect(voiceReducer(s, { type: 'watch', userId: BIA, watching: true })).toBe(s);
  });

  it('survives LiveKit reconnecting, and ends with the call', () => {
    let s = run({ type: 'call', status: 'connected', channelId: 'VC1' }, { type: 'watch', userId: BIA, watching: false }, { type: 'sharing', sharing });
    s = voiceReducer(s, { type: 'call', status: 'reconnecting', channelId: 'VC1' });
    s = voiceReducer(s, { type: 'call', status: 'connected', channelId: 'VC1' });
    expect([s.unwatched, s.sharing]).toEqual([[BIA], sharing]);
    s = voiceReducer(s, { type: 'call', status: 'idle', channelId: null });
    expect([s.unwatched, s.sharing]).toEqual([[], null]);
    s = voiceReducer(run({ type: 'watch', userId: BIA, watching: false }, { type: 'sharing', sharing }), { type: 'reset' });
    expect([s.unwatched, s.sharing]).toEqual([[], null]);
  });

  it('holds for that share only: once voice.state no longer shows the person live in my call, it is forgotten', () => {
    const CAIO = 'c'.repeat(32);
    const state = (participants: VoiceParticipant[]) => ({ type: 'serverEvent' as const, event: { t: 'voice.state', d: { channelId: 'VC1', participants } } });
    let s = run(
      { type: 'welcome', welcome: welcome([{ channelId: 'VC1', participants: [p(ANA), p(BIA, { screen: true }), p(CAIO, { screen: true })] }]) },
      { type: 'call', status: 'connected', channelId: 'VC1' },
      { type: 'watch', userId: BIA, watching: false },
      { type: 'watch', userId: CAIO, watching: false },
    );
    // Still live (a mute, a camera): nothing changes.
    const same = voiceReducer(s, state([p(ANA), p(BIA, { screen: true, muted: true }), p(CAIO, { screen: true })]));
    expect(same.unwatched).toEqual([BIA, CAIO]);
    // Bia stops sharing, Caio leaves the call: their next share is watched again.
    s = voiceReducer(same, state([p(ANA), p(BIA)]));
    expect(s.unwatched).toEqual([]);
  });

  it('who is live in a channel comes from voice.state (screen per person)', () => {
    const s = run({
      type: 'welcome',
      welcome: welcome([
        { channelId: 'VC1', participants: [p(ANA, { screen: true }), p(BIA)] },
        { channelId: 'VC2', participants: [p('c'.repeat(32), { screen: true })] },
      ]),
    });
    expect(liveIn(s, 'VC1')).toEqual([ANA]);
    expect(liveIn(s, 'VC3')).toEqual([]);
  });
});

describe('streamLayout (the screens on the voice stage)', () => {
  const CAIO = 'c'.repeat(32);

  it('every live screen is shown in its tile without a click, in the channel order; none large until clicked', () => {
    expect(streamLayout([BIA, CAIO], [], null)).toEqual({ shown: [BIA, CAIO], focused: null });
    expect(streamLayout([CAIO], [], null)).toEqual({ shown: [CAIO], focused: null });
    expect(streamLayout([BIA, CAIO], [], CAIO)).toEqual({ shown: [BIA, CAIO], focused: CAIO });
  });

  it('a screen I stopped watching is not shown, nor large', () => {
    expect(streamLayout([BIA, CAIO], [BIA], null)).toEqual({ shown: [CAIO], focused: null });
    expect(streamLayout([BIA, CAIO], [BIA], BIA)).toEqual({ shown: [CAIO], focused: null });
  });

  it('only live people: a stream that ended is not shown, nor large', () => {
    expect(streamLayout([CAIO], [], BIA)).toEqual({ shown: [CAIO], focused: null });
    expect(streamLayout([], [], BIA)).toEqual({ shown: [], focused: null });
  });
});
