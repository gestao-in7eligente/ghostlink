import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { directoryFromWelcome } from '../../src/renderer/features/voice/directory.js';

const ME = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
const CAIO = 'c'.repeat(32);
const P = PERMISSIONS;

// The Text track's welcome fields (channels, roles, members), as they ride along to the renderer.
const textWelcome = {
  serverId: 's1',
  self: { userId: ME, nickname: 'Ana', isOwner: false },
  channels: [
    { id: 'TXT', name: 'geral', type: 'text', private: false, allowedRoleIds: [] },
    { id: 'VC1', name: 'Sala de voz', type: 'voice', private: false, allowedRoleIds: [] },
    { id: 'VC2', name: 'Staff', type: 'voice', private: true, allowedRoleIds: ['MODS'] },
  ],
  roles: [
    { id: 'EVERY', permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0, isDefault: true },
    { id: 'MODS', permissions: P.MUTE_MEMBERS | P.MOVE_MEMBERS, position: 2, isDefault: false },
  ],
  members: [
    { userId: ME, nickname: 'Ana', roleIds: ['MODS'] },
    { userId: BIA, nickname: 'Bia', roleIds: [] },
  ],
};

describe('voice directory from the welcome', () => {
  it('names people from the member list, then LiveKit names, then a short id', () => {
    const d = directoryFromWelcome(textWelcome, { [CAIO]: 'Caio (LiveKit)' });
    expect(d.displayName(BIA)).toBe('Bia');
    expect(d.displayName(CAIO)).toBe('Caio (LiveKit)');
    expect(d.displayName('d'.repeat(32))).toBe('dddddddd');
    expect(d.displayName(ME)).toBe('Ana');
  });

  it('lists voice channels in order and names channels', () => {
    const d = directoryFromWelcome(textWelcome, {});
    expect(d.voiceChannels()).toEqual([
      { id: 'VC1', name: 'Sala de voz' },
      { id: 'VC2', name: 'Staff' },
    ]);
    expect(d.channelName('VC1')).toBe('Sala de voz');
    expect(d.channelName('nope')).toBeNull();
  });

  it('computes my bits with the shared rules (only to hide buttons; the server decides)', () => {
    const d = directoryFromWelcome(textWelcome, {});
    expect(d.myPermissions('VC1') & P.MUTE_MEMBERS).toBe(P.MUTE_MEMBERS);
    expect(d.myPermissions('VC2') & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL);
    const bia = directoryFromWelcome({ ...textWelcome, self: { userId: BIA, nickname: 'Bia', isOwner: false } }, {});
    expect(bia.myPermissions('VC1') & P.MUTE_MEMBERS).toBe(0);
    expect(bia.myPermissions('VC2')).toBe(0);
    const owner = directoryFromWelcome({ ...textWelcome, self: { userId: BIA, nickname: 'Bia', isOwner: true } }, {});
    expect(owner.myPermissions('VC2')).toBe(ALL_PERMISSIONS);
  });

  it('without Text data: names from LiveKit, no channels, no moderation (fails closed)', () => {
    const d = directoryFromWelcome({ serverId: 's1', self: { userId: ME, nickname: 'Ana', isOwner: false } }, { [BIA]: 'Bia' });
    expect(d.displayName(BIA)).toBe('Bia');
    expect(d.displayName(ME)).toBe('Ana');
    expect(d.voiceChannels()).toEqual([]);
    expect(d.myPermissions('VC1')).toBe(0);
  });

  it('ignores malformed entries', () => {
    const d = directoryFromWelcome(
      {
        ...textWelcome,
        channels: [{ id: 'VC1', name: 42, type: 'voice' }, 'junk', { id: 'VC3', name: 'Ok', type: 'voice' }],
        members: [{ userId: BIA, nickname: { toString: () => 'x' } }, null],
        roles: 'nope',
      },
      {},
    );
    expect(d.voiceChannels()).toEqual([{ id: 'VC3', name: 'Ok' }]);
    expect(d.displayName(BIA)).toBe('bbbbbbbb');
    expect(d.myPermissions('VC3')).toBe(0);
  });
});
