import { describe, expect, it } from 'vitest';
import type { VoiceParticipant } from '@ghostlink/shared';
import { initialVoiceState, isSpeaking, participantsOf, selfVoice, voiceReducer, type VoiceState } from '../../src/renderer/features/voice/state.js';

const ANA = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
const p = (userId: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  serverMuted: false,
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
