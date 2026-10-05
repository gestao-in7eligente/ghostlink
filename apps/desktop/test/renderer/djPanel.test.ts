// The Ghost DJ's panel (v0.5.1): the state from dj.state, who may control it, the position between
// events, and the labels.
import { describe, expect, it } from 'vitest';
import type { GhostDjState, VoiceParticipant } from '@ghostlink/shared';
import { bandLabel, canControlDj, cookiesDate, cookiesFileProblem, djPosition, djStateOf, formatClock, formatGain, withBand } from '../../src/renderer/features/bots/djModel.js';

const ME = 'a'.repeat(32);
const SALA = 'c'.repeat(32);
const person = (userId: string): VoiceParticipant => ({ userId, muted: false, deafened: false, camera: false, screen: false, serverMuted: false, serverDeafened: false });

const playing: GhostDjState = {
  channelId: SALA,
  current: { title: 'Música', url: 'https://www.youtube.com/watch?v=x', durationSec: 200, requestedBy: ME, requesterName: 'Ana' },
  positionSec: 30,
  paused: false,
  volume: 50,
  loop: 'off',
  next: [],
  queueLength: 0,
  eq: { preset: 'default', gains: [0, 0, 0, 0, 0] },
};

describe('the Ghost DJ panel', () => {
  it('takes dj.state events only, leniently', () => {
    expect(djStateOf({ t: 'dj.state', d: { ...playing, extra: true } })).toEqual(playing);
    expect(djStateOf({ t: 'voice.state', d: playing })).toBeNull();
    expect(djStateOf({ t: 'dj.state', d: { channelId: 5 } })).toBeNull();
  });

  it('may be controlled from its voice channel only', () => {
    expect(canControlDj(playing, { [SALA]: [person(ME)] }, ME)).toBe(true);
    expect(canControlDj(playing, { [SALA]: [person('b'.repeat(32))] }, ME)).toBe(false);
    expect(canControlDj({ ...playing, channelId: null }, { [SALA]: [person(ME)] }, ME)).toBe(false);
    expect(canControlDj(null, {}, ME)).toBe(false);
  });

  it('counts the position on while it plays, holds it while paused, and stops at the end', () => {
    expect(djPosition(playing, 1_000, 6_000)).toBe(35);
    expect(djPosition({ ...playing, paused: true }, 1_000, 6_000)).toBe(30);
    expect(djPosition(playing, 0, 1_000_000)).toBe(200);
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3_725)).toBe('1:02:05');
  });

  it('labels the bands in the app’s language and makes a moved band "custom"', () => {
    expect(bandLabel(60, 'pt-BR')).toBe('60 Hz');
    expect(bandLabel(3_600, 'pt-BR')).toBe('3,6 kHz');
    expect(bandLabel(3_600, 'en')).toBe('3.6 kHz');
    expect(bandLabel(14_000, 'en')).toBe('14 kHz');
    expect(formatGain(3)).toBe('+3');
    expect(formatGain(-5)).toBe('−5');
    expect(withBand({ preset: 'rock', gains: [4, 2, -2, 2, 4] }, 2, 20)).toEqual({ preset: 'custom', gains: [4, 2, 12, 2, 4] });
  });

  it('dates the owner’s YouTube cookies and refuses a file before sending it, a large one without reading it', () => {
    const october2 = new Date(2026, 9, 2, 12).getTime();
    expect(cookiesDate(october2, 'pt-BR')).toBe('02/10');
    expect(cookiesDate(october2, 'en')).toBe('10/02');
    expect(cookiesFileProblem(200 * 1024, null)).toBe('too_large');
    expect(cookiesFileProblem(10, null)).toBeNull();
    const line = ['.youtube.com', 'TRUE', '/', 'TRUE', '0', 'test_name', ['test', 'value'].join('-')].join('\t');
    expect(cookiesFileProblem(100, `# Netscape HTTP Cookie File\n${line}\n`)).toBeNull();
    expect(cookiesFileProblem(100, '{"cookies": []}')).toBe('format');
  });
});
