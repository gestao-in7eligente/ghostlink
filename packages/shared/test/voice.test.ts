import { describe, expect, it } from 'vitest';
import {
  VOICE_LIMITS,
  channelIdFromRoom,
  userIdFromIdentity,
  voiceForceMoveSchemaClient,
  voiceIdentity,
  voiceJoinEndpointsTrusted,
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

describe('voiceJoinEndpointsTrusted (spec §4, §8.2)', () => {
  const trusted = (livekitUrl: string, address: string, iceServers: Array<{ urls: string | string[] }> = []) =>
    voiceJoinEndpointsTrusted({ livekitUrl, iceServers }, address);

  it.each([
    ['wss://127.0.0.1:7700', '127.0.0.1:7700'],
    ['wss://127.0.0.1:7700/', '127.0.0.1:7700'],
    ['wss://Casa.Example.com:7710', 'casa.example.com:7710'],
    ['wss://[::1]:7700', '[::1]:7700'],
    ['wss://[0:0:0:0:0:0:0:1]:7700', '[::1]:7700'],
    ['wss://casa.example.com', 'casa.example.com:443'], // the Host header leaves out the default port
  ])('accepts %s on the connected address %s', (url, address) => {
    expect(trusted(url, address)).toBe(true);
  });

  it.each([
    ['another host', 'wss://evil.example:7700', '127.0.0.1:7700'],
    ['a look-alike host', 'wss://casa.example.com.evil.net:7700', 'casa.example.com:7700'],
    ['another port', 'wss://127.0.0.1:7701', '127.0.0.1:7700'],
    ['the default port instead of the connected one', 'wss://casa.example.com', 'casa.example.com:7700'],
    ['plain ws:', 'ws://127.0.0.1:7700', '127.0.0.1:7700'],
    ['https:', 'https://127.0.0.1:7700', '127.0.0.1:7700'],
    ['credentials', 'wss://user:pw@127.0.0.1:7700', '127.0.0.1:7700'],
    ['a host hidden behind userinfo', 'wss://127.0.0.1:7700@evil.example', '127.0.0.1:7700'],
    ['not a URL', 'nope', '127.0.0.1:7700'],
    ['a bad connected address', 'wss://127.0.0.1:7700', 'not an address!'],
  ])('refuses %s (%s for %s)', (_label, url, address) => {
    expect(trusted(url, address)).toBe(false);
  });

  it('accepts STUN/TURN servers only on the connected host', () => {
    const ok = 'wss://127.0.0.1:7700';
    expect(trusted(ok, '127.0.0.1:7700', [{ urls: 'turn:127.0.0.1:3478?transport=udp' }])).toBe(true);
    expect(trusted(ok, '127.0.0.1:7700', [{ urls: ['stun:127.0.0.1:3478', 'turns:127.0.0.1:5349?transport=tcp', 'turn:127.0.0.1'] }])).toBe(true);
    expect(trusted('wss://[::1]:7700', '[::1]:7700', [{ urls: 'stun:[::1]:3478' }])).toBe(true);
    for (const urls of [
      'stun:stun.l.google.com:19302',
      'turn:evil.example:3478',
      ['stun:127.0.0.1:3478', 'stun:evil.example'],
      'stuns:127.0.0.1',
      'http://127.0.0.1:3478',
      'turn:127.0.0.1?transport=quic',
      'stun:127.0.0.1?transport=udp',
      'turn:user@127.0.0.1',
      'stun:127.0.0.1.evil.net',
      '',
    ]) {
      expect(trusted(ok, '127.0.0.1:7700', [{ urls }]), JSON.stringify(urls)).toBe(false);
    }
  });
});

describe('voice limits (spec §8.2, §13)', () => {
  it('matches the spec', () => {
    expect(VOICE_LIMITS.joinPerWindow).toBe(5);
    expect(VOICE_LIMITS.joinWindowMs).toBe(10_000);
    expect(VOICE_LIMITS.tokenTtlSeconds).toBe(60);
  });
});
