// The call goes on while browsing (spec 2026-10-01-chamada-continua-design.md §2, §3), renderer
// side: the voice store keeps the call's server whatever is on screen, events are routed by
// their origin, voice requests always name the call's server, and the screen's connection
// state never takes the call's background connection for its own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';
import {
  callElsewhere,
  callServerId,
  initialVoiceState,
  participantsOf,
  viewVoice,
  voiceReducer,
  type VoiceAction,
  type VoiceState,
} from '../../src/renderer/features/voice/state.js';
import { lifetime } from '../../src/renderer/features/voice/lifetime.js';
import { useVoiceStore } from '../../src/renderer/features/voice/state.js';
import { connectionReducer, initialConnection } from '../../src/renderer/stores/connection.js';
import { useCallTextStore, takeCallText } from '../../src/renderer/stores/callText.js';
import { initialText } from '../../src/renderer/stores/text.js';
import { BIA, CAIO, ME, harness, participant, type Harness } from './voiceFakes.js';

const OTHER_ME = 'e'.repeat(32);

function welcome(serverId: string, voice: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    serverId,
    address: serverId === 'A' ? '127.0.0.1:7700' : '127.0.0.1:7701',
    self: { userId: serverId === 'A' ? ME : OTHER_ME, nickname: 'Ana', isOwner: false },
    server: { name: serverId === 'A' ? 'Servidor A' : 'Servidor B' },
    features: ['voice'],
    voice,
    ...extra,
  };
}

const run = (s: VoiceState, ...actions: VoiceAction[]) => actions.reduce(voiceReducer, s);
const voiceState = (channelId: string, userIds: string[]) => ({ t: 'voice.state', d: { channelId, participants: userIds.map((u) => participant(u)) } });

/** On A, in a call in VC1 with Bia. */
function inCallOnA(): VoiceState {
  return run(
    initialVoiceState,
    { type: 'view', welcome: welcome('A', [{ channelId: 'VC1', participants: [participant(BIA)] }]) },
    { type: 'call', status: 'connected', channelId: 'VC1' },
  );
}

describe('the voice store during a call elsewhere', () => {
  it('without a call it follows the screen, as before', () => {
    let s = run(initialVoiceState, { type: 'view', welcome: welcome('A') });
    expect(s).toMatchObject({ serverId: 'A', viewServerId: 'A', serverName: 'Servidor A', address: '127.0.0.1:7700', view: null });
    s = run(s, { type: 'view', welcome: welcome('B') });
    expect(s).toMatchObject({ serverId: 'B', selfUserId: OTHER_ME, viewServerId: 'B', view: null });
    s = run(s, { type: 'view', welcome: null });
    expect(s).toMatchObject({ serverId: null, viewServerId: null, available: false });
  });

  it('another server on screen: the call keeps A, B goes to `view`', () => {
    const s = run(inCallOnA(), { type: 'view', welcome: welcome('B', [{ channelId: 'VB', participants: [participant(CAIO)] }]) });
    expect(s).toMatchObject({ serverId: 'A', selfUserId: ME, address: '127.0.0.1:7700', serverName: 'Servidor A' });
    expect(participantsOf(s, 'VC1').map((p) => p.userId)).toEqual([BIA]);
    expect(viewVoice(s)).toMatchObject({ serverId: 'B', selfUserId: OTHER_ME, available: true });
    expect(participantsOf(viewVoice(s), 'VB').map((p) => p.userId)).toEqual([CAIO]);
    expect(callServerId(s)).toBe('A');
    expect(callElsewhere(s)).toBe(true);
  });

  it('the Home screen: the call keeps A and nothing else', () => {
    const s = run(inCallOnA(), { type: 'view', welcome: null });
    expect(s).toMatchObject({ serverId: 'A', viewServerId: null, view: null, call: { status: 'connected', channelId: 'VC1' } });
    expect(callElsewhere(s)).toBe(true);
  });

  it('events go by origin: A\'s to the call, B\'s to the screen, others nowhere', () => {
    let s = run(inCallOnA(), { type: 'view', welcome: welcome('B') });
    s = run(
      s,
      { type: 'serverEvent', serverId: 'A', event: voiceState('VC1', [BIA, ME]) },
      { type: 'serverEvent', serverId: 'B', event: voiceState('VB', [CAIO]) },
      { type: 'serverEvent', serverId: 'Z', event: voiceState('VZ', [CAIO]) },
    );
    expect(participantsOf(s, 'VC1').map((p) => p.userId)).toEqual([BIA, ME]);
    expect(participantsOf(s, 'VB')).toEqual([]);
    expect(participantsOf(viewVoice(s), 'VB').map((p) => p.userId)).toEqual([CAIO]);
    expect(participantsOf(viewVoice(s), 'VC1')).toEqual([]);
    expect(participantsOf(s, 'VZ')).toEqual([]);
  });

  it('back on A: its live state stays, never replaced by the old welcome the screen gets back', () => {
    let s = run(inCallOnA(), { type: 'view', welcome: welcome('B') }, { type: 'serverEvent', serverId: 'A', event: voiceState('VC1', [BIA, ME, CAIO]) });
    s = run(s, { type: 'view', welcome: welcome('A', [{ channelId: 'VC1', participants: [participant(BIA)] }]) });
    expect(participantsOf(s, 'VC1').map((p) => p.userId)).toEqual([BIA, ME, CAIO]);
    expect(s).toMatchObject({ view: null, viewServerId: 'A' });
    expect(callElsewhere(s)).toBe(false);
  });

  it('a reconnect of the call\'s server in the background refreshes it', () => {
    let s = run(inCallOnA(), { type: 'view', welcome: welcome('B') });
    s = run(s, { type: 'serverEvent', serverId: 'A', event: { t: 'welcome', d: welcome('A', [{ channelId: 'VC1', participants: [participant(CAIO)] }]) } });
    expect(participantsOf(s, 'VC1').map((p) => p.userId)).toEqual([CAIO]);
    expect(viewVoice(s).serverId).toBe('B');
  });

  it('the call ending on B\'s screen hands the store to B; on the Home screen it empties', () => {
    const onB = run(inCallOnA(), { type: 'view', welcome: welcome('B', [{ channelId: 'VB', participants: [participant(CAIO)] }]) }, { type: 'self', muted: true });
    const ended = run(onB, { type: 'call', status: 'idle', channelId: null });
    expect(ended).toMatchObject({ serverId: 'B', selfUserId: OTHER_ME, address: '127.0.0.1:7701', serverName: 'Servidor B', view: null, selfMuted: true });
    expect(participantsOf(ended, 'VB').map((p) => p.userId)).toEqual([CAIO]);

    const home = run(inCallOnA(), { type: 'view', welcome: null }, { type: 'call', status: 'idle', channelId: null });
    expect(home).toMatchObject({ serverId: null, available: false, channels: {} });
  });

  it('a move to another channel stays a call: no idle, the old room\'s state goes', () => {
    const s = run(inCallOnA(), { type: 'watch', userId: BIA, watching: true }, { type: 'speaking', userIds: [BIA] }, { type: 'call', status: 'connecting', channelId: 'VC2' });
    expect(s).toMatchObject({ serverId: 'A', call: { status: 'connecting', channelId: 'VC2' }, watching: [], speaking: [] });
  });
});

describe('the session: one call at a time, voice requests to the call\'s server', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness(); // on server s1
  });
  afterEach(async () => {
    await h.session.dispose();
  });

  it('a channel of the server on screen while the call is elsewhere: voice.leave to the old one first, then voice.join there', async () => {
    await h.session.join('VC1');
    const first = h.rooms.at(-1)!;
    h.dispatch({ type: 'view', welcome: { serverId: 's2', address: '127.0.0.1:7700', self: { userId: OTHER_ME }, features: ['voice'], voice: [] } });
    await h.session.join('VB1', { serverId: 's2' });
    expect(h.routed).toEqual([
      ['voice.join', 's1'],
      ['voice.selfState', 's1'],
      ['voice.leave', 's1'],
      ['voice.join', 's2'],
      ['voice.selfState', 's2'],
    ]);
    expect(first.disconnects).toBe(1);
    expect(h.state()).toMatchObject({ serverId: 's2', selfUserId: OTHER_ME, view: null, call: { status: 'connected', channelId: 'VB1' } });
  });

  it('the same channel id on the screen\'s server is still another call', async () => {
    await h.session.join('VC1');
    h.dispatch({ type: 'view', welcome: { serverId: 's2', address: '127.0.0.1:7700', self: { userId: OTHER_ME }, features: ['voice'], voice: [] } });
    await h.session.join('VC1', { serverId: 's2' });
    expect(h.routed.filter(([t]) => t === 'voice.join')).toEqual([['voice.join', 's1'], ['voice.join', 's2']]);
  });

  it('hanging up from another server tells the call\'s server, before the store moves to the screen\'s', async () => {
    await h.session.join('VC1');
    h.dispatch({ type: 'view', welcome: { serverId: 's2', address: '127.0.0.1:7700', self: { userId: OTHER_ME }, features: ['voice'], voice: [] } });
    await h.session.leave();
    expect(h.routed.at(-1)).toEqual(['voice.leave', 's1']);
    expect(h.state()).toMatchObject({ serverId: 's2', call: { status: 'idle', channelId: null } });
  });

  it('a move (voice.forceMove) never passes through idle, so the call\'s server stays', async () => {
    await h.session.join('VC1');
    h.dispatch({ type: 'view', welcome: { serverId: 's2', address: '127.0.0.1:7700', self: { userId: OTHER_ME }, features: ['voice'], voice: [] } });
    const statuses: string[] = [];
    const dispatch = h.deps.dispatch;
    h.deps.dispatch = (a) => {
      if (a.type === 'call') statuses.push(a.status);
      dispatch(a);
    };
    await h.session.handleServerEvent({ t: 'voice.forceMove', d: { toChannelId: 'VC2' } });
    expect(statuses).not.toContain('idle');
    expect(h.routed.filter(([t]) => t === 'voice.join').at(-1)).toEqual(['voice.join', 's1']);
    expect(h.state()).toMatchObject({ serverId: 's1', call: { status: 'connected', channelId: 'VC2' } });
    expect(viewVoice(h.state()).serverId).toBe('s2');
  });
});

describe('the screen\'s connection state and the call\'s background connection', () => {
  const rendererWelcome = (serverId: string): RendererWelcome => ({
    serverId,
    address: '127.0.0.1:7700',
    self: { userId: 'a'.repeat(32), nickname: 'Ana', isOwner: false },
    sessionId: 's',
    serverTime: 1,
    server: { name: 'Casa', version: '0.3.1', joinMode: 'invite', serverKeyId: 'k'.repeat(43) },
    features: [],
    protocol: { min: 1, max: 1 },
  });

  it('ignores the background connection\'s states and events', () => {
    const onB = connectionReducer(initialConnection, { type: 'joined', welcome: rendererWelcome('B') });
    expect(connectionReducer(onB, { type: 'state', event: { state: 'reconnecting', serverId: 'A', background: true } })).toBe(onB);
    expect(connectionReducer(onB, { type: 'state', event: { state: 'failed', serverId: 'A', error: 'KICKED', background: true } })).toBe(onB);
    expect(connectionReducer(onB, { type: 'serverEvent', serverId: 'A', event: { t: 'welcome', d: rendererWelcome('A') } })).toBe(onB);
    const home = connectionReducer(initialConnection, { type: 'state', event: { state: 'reconnecting', serverId: 'A', background: true } });
    expect(home).toBe(initialConnection);
  });

  it('`left`: nothing on screen (the Home screen)', () => {
    const onA = connectionReducer(initialConnection, { type: 'joined', welcome: rendererWelcome('A') });
    expect(connectionReducer(onA, { type: 'left' })).toEqual(initialConnection);
  });
});

describe('the kept text state of the call\'s server', () => {
  afterEach(() => useCallTextStore.setState({ text: null }));

  it('is handed back once, and only for its own server', () => {
    const text = { ...initialText, server: { ...initialText.server, serverId: 'A' } };
    useCallTextStore.setState({ text });
    expect(takeCallText('B')).toBeNull();
    expect(takeCallText('A')).toBe(text);
    expect(takeCallText('A')).toBeNull();
  });
});

describe('the runtimes outlive their components while a call is on', () => {
  afterEach(() => useVoiceStore.setState(initialVoiceState));

  it('stops with the last user when no call is on; during one, once it ends; a new user cancels that', async () => {
    let starts = 0;
    let stops = 0;
    const life = lifetime(() => {
      starts++;
      return () => void stops++;
    });
    life.retain();
    life.release();
    expect([starts, stops]).toEqual([1, 1]);

    life.retain();
    useVoiceStore.setState({ call: { status: 'connected', channelId: 'VC1' } });
    life.release(); // the server's layout unmounts (the Home screen)
    expect(stops).toBe(1);
    life.retain(); // the Home screen's panel mounts
    expect(starts).toBe(2); // the same run goes on
    life.release();
    useVoiceStore.setState({ call: { status: 'idle', channelId: null } });
    await Promise.resolve();
    expect([starts, stops]).toEqual([2, 2]);
  });
});
