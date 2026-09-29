import { describe, expect, it } from 'vitest';
import {
  VOICE_LIMITS,
  channelIdFromRoom,
  userIdFromIdentity,
  voiceForceMoveSchemaClient,
  voiceIdentity,
  voiceJoinResponseSchemaClient,
  voiceJoinSchema,
  voiceLeaveSchema,
  voiceModerateSchema,
  voiceRoomName,
  voiceSelfStateSchema,
  voiceStateSchemaClient,
  voiceWelcomeSchemaClient,
} from '../src/index.js';

const USER = '0123456789abcdef0123456789abcdef';

describe('voice room and identity names (spec §8.2)', () => {
  it('maps channels to ch_<id> rooms and users to u_<id> identities, both ways', () => {
    expect(voiceRoomName('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('ch_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(channelIdFromRoom('ch_ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(voiceIdentity(USER)).toBe(`u_${USER}`);
    expect(userIdFromIdentity(`u_${USER}`)).toBe(USER);
  });

  it('rejects anything that is not exactly one of our names', () => {
    for (const room of ['', 'ch_', 'CH_abc', 'room', 'ch_a b', 'ch_../x', `ch_${'a'.repeat(65)}`, 'xch_abc']) {
      expect(channelIdFromRoom(room)).toBeNull();
    }
    for (const identity of ['', 'u_', `u_${USER.toUpperCase()}`, `u_${USER}0`, `x_${USER}`, USER, `u_${USER.slice(1)}`]) {
      expect(userIdFromIdentity(identity)).toBeNull();
    }
  });

  it('refuses to build names from invalid ids', () => {
    expect(() => voiceRoomName('a/b')).toThrow();
    expect(() => voiceIdentity('not-a-user')).toThrow();
  });
});

describe('voice request schemas are strict (spec §5.1, §5.2)', () => {
  it('voice.join takes only a channel id', () => {
    expect(voiceJoinSchema.parse({ channelId: 'abc123' })).toEqual({ channelId: 'abc123' });
    expect(() => voiceJoinSchema.parse({ channelId: 'abc', extra: 1 })).toThrow();
    expect(() => voiceJoinSchema.parse({})).toThrow();
    expect(() => voiceJoinSchema.parse({ channelId: '' })).toThrow();
    expect(() => voiceJoinSchema.parse({ channelId: 'x'.repeat(65) })).toThrow();
    expect(() => voiceJoinSchema.parse({ channelId: '../../etc' })).toThrow();
  });

  it('voice.leave takes an empty object', () => {
    expect(voiceLeaveSchema.parse({})).toEqual({});
    expect(() => voiceLeaveSchema.parse({ channelId: 'abc' })).toThrow();
  });

  it('voice.selfState needs both booleans', () => {
    expect(voiceSelfStateSchema.parse({ muted: true, deafened: false })).toEqual({ muted: true, deafened: false });
    expect(() => voiceSelfStateSchema.parse({ muted: true })).toThrow();
    expect(() => voiceSelfStateSchema.parse({ muted: 'yes', deafened: false })).toThrow();
    expect(() => voiceSelfStateSchema.parse({ muted: true, deafened: false, serverMuted: false })).toThrow();
  });

  it('voice.moderate: move needs a target channel, the other actions refuse one', () => {
    expect(voiceModerateSchema.parse({ userId: USER, action: 'mute' })).toEqual({ userId: USER, action: 'mute' });
    expect(voiceModerateSchema.parse({ userId: USER, action: 'move', toChannelId: 'c2' })).toEqual({ userId: USER, action: 'move', toChannelId: 'c2' });
    expect(() => voiceModerateSchema.parse({ userId: USER, action: 'move' })).toThrow();
    expect(() => voiceModerateSchema.parse({ userId: USER, action: 'mute', toChannelId: 'c2' })).toThrow();
    expect(() => voiceModerateSchema.parse({ userId: USER, action: 'ban' })).toThrow();
    expect(() => voiceModerateSchema.parse({ userId: 'nope', action: 'mute' })).toThrow();
    expect(() => voiceModerateSchema.parse({ userId: USER, action: 'unmute', x: 1 })).toThrow();
  });
});

describe('voice client schemas are lenient (spec §5.1)', () => {
  const participant = { userId: USER, muted: false, deafened: true, camera: false, screen: false, serverMuted: true };

  it('keeps known fields and drops unknown ones', () => {
    const parsed = voiceStateSchemaClient.parse({ channelId: 'c1', participants: [{ ...participant, future: 1 }], extra: true });
    expect(parsed).toEqual({ channelId: 'c1', participants: [participant] });
  });

  it('parses the welcome field and the join response', () => {
    expect(voiceWelcomeSchemaClient.parse([{ channelId: 'c1', participants: [participant] }])).toHaveLength(1);
    const res = voiceJoinResponseSchemaClient.parse({ livekitUrl: 'wss://1.2.3.4:7700', token: 'a.b.c', iceServers: [], x: 1 });
    expect(res).toEqual({ livekitUrl: 'wss://1.2.3.4:7700', token: 'a.b.c', iceServers: [] });
    expect(voiceForceMoveSchemaClient.parse({ toChannelId: 'c9' })).toEqual({ toChannelId: 'c9' });
  });

  it('rejects malformed participants', () => {
    expect(() => voiceStateSchemaClient.parse({ channelId: 'c1', participants: [{ ...participant, userId: 'x' }] })).toThrow();
    expect(() => voiceJoinResponseSchemaClient.parse({ livekitUrl: 'wss://x', token: 'a'.repeat(20_000), iceServers: [] })).toThrow();
  });
});

describe('voice limits (spec §8.2, §13)', () => {
  it('matches the spec', () => {
    expect(VOICE_LIMITS.joinPerWindow).toBe(5);
    expect(VOICE_LIMITS.joinWindowMs).toBe(10_000);
    expect(VOICE_LIMITS.tokenTtlSeconds).toBe(60);
  });
});
