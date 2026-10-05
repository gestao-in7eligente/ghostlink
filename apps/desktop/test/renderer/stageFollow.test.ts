import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useVoiceStore } from '../../src/renderer/features/voice/state.js';
import { followCallOnStage, stageAfterCallMove } from '../../src/renderer/integration/stageFollow.js';
import { initialText, useTextStore } from '../../src/renderer/stores/text.js';
import { GERAL, VOICE, channel, snapshot, start } from './textFixtures.js';

const SALA2 = 'W'.repeat(26);

describe('the voice stage follows the call (stageAfterCallMove)', () => {
  it('moves the stage when it showed the channel the call just left', () => {
    expect(stageAfterCallMove(VOICE, VOICE, SALA2)).toBe(SALA2);
  });

  it('leaves the chat, and any other voice channel on screen, alone', () => {
    expect(stageAfterCallMove(null, VOICE, SALA2)).toBeNull();
    expect(stageAfterCallMove('X'.repeat(26), VOICE, SALA2)).toBe('X'.repeat(26));
  });

  it('changes nothing for a first join or a rejoin of the same channel', () => {
    expect(stageAfterCallMove(VOICE, null, SALA2)).toBe(VOICE);
    expect(stageAfterCallMove(VOICE, VOICE, VOICE)).toBe(VOICE);
  });
});

describe('followCallOnStage (live stores)', () => {
  let stop: () => void = () => {};
  const call = (status: 'idle' | 'connecting' | 'connected', channelId: string | null) => useVoiceStore.getState().dispatch({ type: 'call', status, channelId });
  const stage = () => useTextStore.getState().channels.stageId;

  beforeEach(() => {
    const snap = snapshot({ channels: [channel(GERAL, 'geral', 0), channel(VOICE, 'Sala de voz', 1, { type: 'voice' }), channel(SALA2, 'Sala 2', 2, { type: 'voice' })] });
    useTextStore.setState(start(snap));
    call('idle', null);
  });

  afterEach(() => {
    stop();
    call('idle', null);
    useTextStore.setState(initialText);
  });

  it('a moderator moves me (voice.forceMove: idle, then the new channel): the stage goes with the call', () => {
    // I opened "Sala de voz" from the sidebar and joined it.
    useTextStore.getState().dispatch({ type: 'stage', channelId: VOICE });
    stop = followCallOnStage();
    call('connecting', VOICE);
    call('connected', VOICE);
    expect(stage()).toBe(VOICE);
    // The session tears the old room down, then joins the target.
    call('idle', null);
    call('connecting', SALA2);
    expect(stage()).toBe(SALA2);
    call('connected', SALA2);
    expect(stage()).toBe(SALA2);
  });

  it('while I read a text channel, a move does not pull me away from it', () => {
    stop = followCallOnStage();
    useTextStore.getState().dispatch({ type: 'stage', channelId: VOICE });
    call('connected', VOICE);
    useTextStore.getState().dispatch({ type: 'select', channelId: GERAL });
    call('idle', null);
    call('connected', SALA2);
    expect(stage()).toBeNull();
    expect(useTextStore.getState().channels.activeId).toBe(GERAL);
  });

  it('my own switch from the sidebar (stage first, then the join) stays where I clicked', () => {
    stop = followCallOnStage();
    useTextStore.getState().dispatch({ type: 'stage', channelId: VOICE });
    call('connected', VOICE);
    useTextStore.getState().dispatch({ type: 'stage', channelId: SALA2 });
    call('idle', null);
    call('connecting', SALA2);
    expect(stage()).toBe(SALA2);
  });

  it('stops following once unsubscribed', () => {
    useTextStore.getState().dispatch({ type: 'stage', channelId: VOICE });
    stop = followCallOnStage();
    call('connected', VOICE);
    stop();
    call('idle', null);
    call('connected', SALA2);
    expect(stage()).toBe(VOICE);
  });
});
