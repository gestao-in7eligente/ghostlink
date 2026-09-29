import { describe, expect, it } from 'vitest';
import { PERMISSIONS, has } from '@ghostlink/shared';
import { voiceDirectoryFromText } from '../../src/renderer/integration/voiceDirectory.js';
import { BOB, FANS_ROLE, GERAL, ME, SECRET, VOICE, channel, snapshot, start } from './textFixtures.js';

describe('voice directory from the live Text stores (integration seam)', () => {
  it('names members by their current nickname, falling back to a short id', () => {
    const dir = voiceDirectoryFromText(start());
    expect(dir.displayName(BOB)).toBe('Bob');
    expect(dir.displayName('z'.repeat(32))).toBe('zzzzzzzz');
  });

  it('knows channel names and lists only voice channels, in display order', () => {
    const dir = voiceDirectoryFromText(start());
    expect(dir.channelName(GERAL)).toBe('geral');
    expect(dir.channelName('nope')).toBeNull();
    expect(dir.voiceChannels()).toEqual([{ id: VOICE, name: 'Sala de voz' }]);
  });

  it('computes my permissions with the private-channel rules (not just @everyone)', () => {
    const snap = snapshot({
      channels: [
        channel(GERAL, 'geral', 0),
        channel(VOICE, 'Sala de voz', 1, { type: 'voice' }),
        channel(SECRET, 'Sala secreta', 2, { type: 'voice', private: true, allowedRoleIds: ['nobody'] }),
      ],
    });
    const dir = voiceDirectoryFromText(start(snap));
    expect(has(dir.myPermissions(VOICE), PERMISSIONS.CONNECT_VOICE)).toBe(true);
    // ME has only @todos + Fãs, not on the private channel's list: no rights there.
    expect(dir.myPermissions(SECRET)).toBe(0);
  });

  it('follows role changes: a private channel opened to my role becomes reachable', () => {
    const snap = snapshot({
      channels: [channel(SECRET, 'Sala secreta', 0, { type: 'voice', private: true, allowedRoleIds: [FANS_ROLE] })],
    });
    const dir = voiceDirectoryFromText(start(snap));
    expect(has(dir.myPermissions(SECRET), PERMISSIONS.CONNECT_VOICE)).toBe(true);
    expect(ME).toBeDefined();
  });
});
