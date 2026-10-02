import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { userMenuEntries, type UserMenuFacts } from '../../src/renderer/features/userMenu/userMenuModel.js';

const P = PERMISSIONS;

/** Someone else, outside any call, seen by a member without moderation rights. */
const base: UserMenuFacts = {
  self: false,
  canOpenProfile: true,
  canEditProfile: true,
  voiceChannelId: null,
  serverBits: DEFAULT_EVERYONE_PERMISSIONS,
  channelBits: 0,
  above: false,
  manageableRoles: 0,
  moveTargets: 0,
  serverDeafen: true,
};

/** A moderator above them, with every bit in the server and in their voice channel. */
const moderator: UserMenuFacts = { ...base, voiceChannelId: 'VC1', serverBits: ALL_PERMISSIONS, channelBits: ALL_PERMISSIONS, above: true, manageableRoles: 2, moveTargets: 1 };

describe("a person's menu: which items show (spec 2026-10-02-menu-do-usuario §2)", () => {
  it('someone else outside a call: profile, mention and the id only', () => {
    expect(userMenuEntries(base)).toEqual(['profile', 'mention', 'separator', 'copyId']);
  });

  it('someone else in a call I see: mute for me only and their volume', () => {
    expect(userMenuEntries({ ...base, voiceChannelId: 'VC1' })).toEqual(['profile', 'mention', 'separator', 'localMute', 'volume', 'separator', 'copyId']);
  });

  it('myself: editing my server profile, and my own mute and deafen while in a call', () => {
    expect(userMenuEntries({ ...base, self: true })).toEqual(['profile', 'mention', 'separator', 'editServerProfile', 'separator', 'copyId']);
    expect(userMenuEntries({ ...base, self: true, voiceChannelId: 'VC1' })).toEqual([
      'profile', 'mention', 'separator', 'selfMute', 'selfDeafen', 'editServerProfile', 'separator', 'copyId',
    ]);
  });

  it('never moderation on myself, whatever my bits (the server answers HIERARCHY)', () => {
    const me = userMenuEntries({ ...moderator, self: true, above: false });
    expect(me).toEqual(['profile', 'mention', 'separator', 'selfMute', 'selfDeafen', 'editServerProfile', 'separator', 'copyId']);
  });

  it('a moderator above them sees everything, in order', () => {
    expect(userMenuEntries(moderator)).toEqual([
      'profile', 'mention',
      'separator', 'localMute', 'volume', 'roles',
      'separator', 'serverMute', 'serverDeafen', 'move', 'disconnect', 'kick', 'ban',
      'separator', 'copyId',
    ]);
  });

  it('the bits alone are not enough: below or level with them, no roles nor moderation', () => {
    expect(userMenuEntries({ ...moderator, above: false })).toEqual(['profile', 'mention', 'separator', 'localMute', 'volume', 'separator', 'copyId']);
  });

  it('voice moderation follows my bits in their channel, kick and ban my bits in the server', () => {
    const facts = { ...moderator, channelBits: DEFAULT_EVERYONE_PERMISSIONS, serverBits: DEFAULT_EVERYONE_PERMISSIONS | P.KICK_MEMBERS };
    expect(userMenuEntries(facts)).toEqual(['profile', 'mention', 'separator', 'localMute', 'volume', 'separator', 'kick', 'separator', 'copyId']);
    const muteOnly = userMenuEntries({ ...moderator, channelBits: P.VIEW_CHANNEL | P.MUTE_MEMBERS, serverBits: 0 });
    expect(muteOnly).toEqual(['profile', 'mention', 'separator', 'localMute', 'volume', 'separator', 'serverMute', 'serverDeafen', 'separator', 'copyId']);
  });

  it('no voice moderation for someone outside a call; kick, ban and roles stay', () => {
    expect(userMenuEntries({ ...moderator, voiceChannelId: null, channelBits: 0 })).toEqual([
      'profile', 'mention', 'separator', 'roles', 'separator', 'kick', 'ban', 'separator', 'copyId',
    ]);
  });

  it('"Desativar áudio no servidor" only where the server takes it, "Mover para" only with somewhere to go', () => {
    const entries = userMenuEntries({ ...moderator, serverDeafen: false, moveTargets: 0 });
    expect(entries).toContain('serverMute');
    expect(entries).not.toContain('serverDeafen');
    expect(entries).not.toContain('move');
    expect(entries).toContain('disconnect');
  });

  it('"Cargos" needs roles I may give; no "Perfil" where no card can show; no profile editing without the settings', () => {
    expect(userMenuEntries({ ...moderator, manageableRoles: 0 })).not.toContain('roles');
    expect(userMenuEntries({ ...base, canOpenProfile: false })).toEqual(['mention', 'separator', 'copyId']);
    expect(userMenuEntries({ ...base, self: true, canEditProfile: false })).toEqual(['profile', 'mention', 'separator', 'copyId']);
  });
});
