import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { canOpenServerSettings, moveChannel, reorderedRoleIds, settingsTabs } from '../../src/renderer/features/server-settings/access.js';
import { serverInitials, suggestNickname } from '../../src/renderer/layout/names.js';
import { EMOJI, QUICK_REACTIONS } from '../../src/renderer/features/chat/emoji.js';
import { isReactionEmoji } from '@ghostlink/shared';
import { GERAL, RANDOM, SECRET, VOICE, channel } from './textFixtures.js';

describe('server settings tabs follow permissions (UI only; the server re-checks)', () => {
  it('a plain member sees none, so the menu hides "Configurações do servidor"', () => {
    expect(settingsTabs(DEFAULT_EVERYONE_PERMISSIONS, false)).toEqual([]);
    expect(canOpenServerSettings(DEFAULT_EVERYONE_PERMISSIONS, false)).toBe(false);
  });

  it('each permission opens its tab; the owner also transfers ownership', () => {
    expect(settingsTabs(PERMISSIONS.CREATE_INVITES, false)).toEqual(['invites']);
    expect(settingsTabs(PERMISSIONS.KICK_MEMBERS, false)).toEqual(['members']);
    expect(settingsTabs(PERMISSIONS.BAN_MEMBERS, false)).toEqual(['members', 'bans']);
    expect(settingsTabs(PERMISSIONS.MANAGE_CHANNELS, false)).toEqual(['channels']);
    expect(settingsTabs(ALL_PERMISSIONS, true)).toEqual(['overview', 'channels', 'roles', 'members', 'invites', 'bans', 'transfer']);
    expect(settingsTabs(ALL_PERMISSIONS, false)).not.toContain('transfer');
  });
});

describe('reordering', () => {
  const all = [channel(GERAL, 'geral', 0), channel(VOICE, 'voz', 1, { type: 'voice' }), channel(RANDOM, 'random', 2), channel(SECRET, 'segredo', 3)];

  it('moves a channel among its own type and keeps the other type in place', () => {
    expect(moveChannel(all, RANDOM, -1)).toEqual([RANDOM, VOICE, GERAL, SECRET]);
    expect(moveChannel(all, RANDOM, 1)).toEqual([GERAL, VOICE, SECRET, RANDOM]);
    expect(moveChannel(all, GERAL, -1)).toBeNull();
    expect(moveChannel(all, VOICE, 1)).toBeNull();
    expect(moveChannel(all, 'X', 1)).toBeNull();
  });

  it('moves a role to a new index', () => {
    expect(reorderedRoleIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reorderedRoleIds(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(reorderedRoleIds(['a', 'b', 'c'], 'x', 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('small helpers', () => {
  it('suggests nickname#2 when a nickname is taken (spec §7)', () => {
    expect(suggestNickname('Ana')).toBe('Ana#2');
    expect(suggestNickname('Ana#2')).toBe('Ana#3');
  });

  it('shows server initials in the rail', () => {
    expect(serverInitials('Estação Monky')).toBe('EM');
    expect(serverInitials('casa')).toBe('C');
    expect(serverInitials('   ')).toBe('?');
    expect(serverInitials('👻 Fantasmas')).toBe('👻F');
  });

  it('every emoji in the pickers is a valid reaction', () => {
    for (const e of [...EMOJI, ...QUICK_REACTIONS]) expect(isReactionEmoji(e), e).toBe(true);
    expect(new Set(EMOJI).size).toBe(EMOJI.length);
  });
});
