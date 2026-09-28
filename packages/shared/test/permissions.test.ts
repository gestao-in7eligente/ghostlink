import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  EVERYONE_POSITION,
  PERMISSIONS,
  PERMISSION_NAMES,
  canActOn,
  canGrant,
  canManageRole,
  has,
  isPermissionBits,
  permissionsFor,
  topPosition,
  voiceSourcesFor,
  type PermissionName,
} from '../src/index.js';

const P = PERMISSIONS;
const member = (roles: { id: string; permissions: number; position: number }[] = [], everyone = DEFAULT_EVERYONE_PERMISSIONS) => ({
  isOwner: false,
  everyone,
  roles,
});

describe('permission bits (spec §6)', () => {
  it('keeps every bit at its fixed position (never renumber)', () => {
    const expected: Record<PermissionName, number> = {
      VIEW_CHANNEL: 0,
      SEND_MESSAGES: 1,
      ADD_REACTIONS: 2,
      ATTACH_FILES: 3,
      MENTION_EVERYONE: 4,
      CREATE_INVITES: 5,
      CONNECT_VOICE: 6,
      SPEAK: 7,
      VIDEO: 8,
      MANAGE_MESSAGES: 9,
      MANAGE_CHANNELS: 10,
      MANAGE_ROLES: 11,
      MANAGE_SERVER: 12,
      KICK_MEMBERS: 13,
      BAN_MEMBERS: 14,
      MUTE_MEMBERS: 15,
      MOVE_MEMBERS: 16,
      ADMINISTRATOR: 17,
    };
    expect(Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Math.log2(v)]))).toEqual(expected);
    expect(PERMISSION_NAMES).toEqual(Object.keys(expected));
  });

  it('ALL_PERMISSIONS is the OR of every bit and stays below 2^31', () => {
    expect(ALL_PERMISSIONS).toBe(Object.values(P).reduce((a, b) => a | b, 0));
    expect(ALL_PERMISSIONS).toBe(2 ** 18 - 1);
    expect(ALL_PERMISSIONS).toBeLessThan(2 ** 31);
  });

  it('@everyone defaults match the spec and exclude CREATE_INVITES', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(
      P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.CONNECT_VOICE | P.SPEAK | P.VIDEO,
    );
    expect(has(DEFAULT_EVERYONE_PERMISSIONS, P.CREATE_INVITES)).toBe(false);
    expect(has(DEFAULT_EVERYONE_PERMISSIONS, P.MENTION_EVERYONE)).toBe(false);
  });

  it('has() requires every bit of the flag', () => {
    expect(has(P.SEND_MESSAGES | P.ATTACH_FILES, P.SEND_MESSAGES)).toBe(true);
    expect(has(P.SEND_MESSAGES, P.SEND_MESSAGES | P.ATTACH_FILES)).toBe(false);
    expect(has(0, P.VIEW_CHANNEL)).toBe(false);
    expect(has(ALL_PERMISSIONS, P.ADMINISTRATOR)).toBe(true);
  });

  it('isPermissionBits accepts only integers made of known bits', () => {
    expect(isPermissionBits(0)).toBe(true);
    expect(isPermissionBits(ALL_PERMISSIONS)).toBe(true);
    expect(isPermissionBits(P.KICK_MEMBERS | P.SPEAK)).toBe(true);
    for (const bad of [-1, 1.5, ALL_PERMISSIONS + 1, 2 ** 18, 2 ** 31, 2 ** 40, Number.NaN, Infinity, '1', null, undefined]) {
      expect(isPermissionBits(bad), String(bad)).toBe(false);
    }
  });
});

describe('permissionsFor', () => {
  it('ORs @everyone with the member roles', () => {
    const bits = permissionsFor(member([{ id: 'r1', permissions: P.CREATE_INVITES, position: 1 }, { id: 'r2', permissions: P.KICK_MEMBERS, position: 2 }]));
    expect(bits).toBe(DEFAULT_EVERYONE_PERMISSIONS | P.CREATE_INVITES | P.KICK_MEMBERS);
  });

  it('with no roles is exactly @everyone', () => {
    expect(permissionsFor(member())).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(permissionsFor(member([], 0))).toBe(0);
  });

  it('gives the owner everything, whatever the roles say', () => {
    expect(permissionsFor({ isOwner: true, everyone: 0, roles: [] })).toBe(ALL_PERMISSIONS);
    expect(permissionsFor({ isOwner: true, everyone: 0, roles: [] }, { private: true, allowedRoleIds: [] })).toBe(ALL_PERMISSIONS);
  });

  it('ADMINISTRATOR implies every other bit', () => {
    expect(permissionsFor(member([{ id: 'admin', permissions: P.ADMINISTRATOR, position: 5 }], 0))).toBe(ALL_PERMISSIONS);
    expect(permissionsFor(member([], P.ADMINISTRATOR))).toBe(ALL_PERMISSIONS); // even through @everyone
  });

  it('ignores unknown or invalid stored bits (fail closed)', () => {
    expect(permissionsFor(member([{ id: 'r', permissions: -1, position: 1 }], 0))).toBe(0);
    expect(permissionsFor(member([{ id: 'r', permissions: 2 ** 31 + P.ADMINISTRATOR, position: 1 }], 0))).toBe(0);
    expect(permissionsFor(member([{ id: 'r', permissions: (1 << 20) | P.SPEAK, position: 1 }], 0))).toBe(P.SPEAK);
    expect(permissionsFor(member([], Number.NaN))).toBe(0);
  });

  it('a public channel uses the server-level permissions', () => {
    const user = member([{ id: 'r1', permissions: P.MANAGE_MESSAGES, position: 1 }]);
    expect(permissionsFor(user, { private: false, allowedRoleIds: [] })).toBe(permissionsFor(user));
  });

  describe('private channel matrix', () => {
    const channel = { private: true, allowedRoleIds: ['staff'] };
    const staff = { id: 'staff', permissions: 0, position: 2 };
    const other = { id: 'other', permissions: P.MANAGE_CHANNELS | P.MANAGE_ROLES, position: 3 };

    it.each([
      // [case, subject, can view]
      ['plain member, not listed', member(), false],
      ['member with an unrelated role (even MANAGE_CHANNELS), not listed', member([other]), false],
      ['member with a listed role', member([staff]), true],
      ['member with a listed and an unlisted role', member([other, staff]), true],
      ['listed role but no VIEW_CHANNEL anywhere', member([staff], DEFAULT_EVERYONE_PERMISSIONS & ~P.VIEW_CHANNEL), false],
      ['listed role that itself grants VIEW_CHANNEL', member([{ ...staff, permissions: P.VIEW_CHANNEL }], 0), true],
      ['administrator, not listed', member([{ id: 'admin', permissions: P.ADMINISTRATOR, position: 9 }], 0), true],
      ['owner, not listed', { isOwner: true, everyone: 0, roles: [] }, true],
    ] as const)('%s', (_label, subject, canView) => {
      expect(has(permissionsFor(subject, channel), P.VIEW_CHANNEL)).toBe(canView);
    });

    it('an unlisted member has no permission at all inside the channel', () => {
      expect(permissionsFor(member([other]), channel)).toBe(0);
    });

    it('a listed member keeps the rest of their permissions there', () => {
      expect(permissionsFor(member([staff, other]), channel)).toBe(permissionsFor(member([staff, other])));
    });

    it('an empty allow list hides the channel from everyone but admins and the owner', () => {
      const empty = { private: true, allowedRoleIds: [] };
      expect(permissionsFor(member([staff]), empty)).toBe(0);
      expect(permissionsFor(member([{ id: 'a', permissions: P.ADMINISTRATOR, position: 1 }]), empty)).toBe(ALL_PERMISSIONS);
    });
  });
});

describe('hierarchy', () => {
  const role = (position: number) => ({ id: `r${position}`, permissions: 0, position });
  const user = (...positions: number[]) => ({ isOwner: false, roles: positions.map(role) });
  const owner = { isOwner: true, roles: [] };

  it('topPosition is the highest role, @everyone when there is none', () => {
    expect(topPosition([role(2), role(7), role(3)])).toBe(7);
    expect(topPosition([])).toBe(EVERYONE_POSITION);
    expect(EVERYONE_POSITION).toBe(0);
  });

  it('acts only on members whose top role is strictly below', () => {
    expect(canActOn(user(5), user(4))).toBe(true);
    expect(canActOn(user(5), user(5))).toBe(false); // same level
    expect(canActOn(user(5), user(6))).toBe(false);
    expect(canActOn(user(1, 9), user(8, 2))).toBe(true); // compares the highest role of each
    expect(canActOn(user(1), user())).toBe(true); // anyone with a role outranks a bare member
    expect(canActOn(user(), user())).toBe(false);
  });

  it('nobody acts on themselves', () => {
    const self = user(5);
    expect(canActOn(self, self)).toBe(false);
    expect(canActOn(owner, owner)).toBe(false);
  });

  it('the owner is above everyone and nobody acts on the owner', () => {
    expect(canActOn(owner, user(1_000))).toBe(true);
    expect(canActOn(owner, user())).toBe(true);
    expect(canActOn(user(1_000), owner)).toBe(false);
  });

  it('ADMINISTRATOR does not bypass the hierarchy (only positions count)', () => {
    const admin = { isOwner: false, roles: [{ id: 'a', permissions: P.ADMINISTRATOR, position: 2 }] };
    expect(canActOn(admin, user(3))).toBe(false);
  });

  it('canManageRole: only roles strictly below the actor top role; the owner manages all', () => {
    expect(canManageRole(user(5), role(4))).toBe(true);
    expect(canManageRole(user(5), role(5))).toBe(false);
    expect(canManageRole(user(5), role(6))).toBe(false);
    expect(canManageRole(user(1), { position: EVERYONE_POSITION })).toBe(true);
    expect(canManageRole(user(), { position: EVERYONE_POSITION })).toBe(false);
    expect(canManageRole(owner, role(1_000))).toBe(true);
  });
});

describe('canGrant', () => {
  it('nobody grants a bit they do not have', () => {
    const actor = P.MANAGE_ROLES | P.SEND_MESSAGES | P.KICK_MEMBERS;
    expect(canGrant(actor, P.SEND_MESSAGES | P.KICK_MEMBERS)).toBe(true);
    expect(canGrant(actor, 0)).toBe(true);
    expect(canGrant(actor, P.SEND_MESSAGES | P.BAN_MEMBERS)).toBe(false);
    expect(canGrant(actor, P.ADMINISTRATOR)).toBe(false);
  });

  it('with effective permissions an administrator or the owner can grant anything', () => {
    const adminBits = permissionsFor(member([{ id: 'a', permissions: P.ADMINISTRATOR, position: 1 }]));
    expect(canGrant(adminBits, ALL_PERMISSIONS)).toBe(true);
  });

  it('only bits being added count when editing an existing role', () => {
    const actor = P.MANAGE_ROLES | P.SEND_MESSAGES;
    const current = P.BAN_MEMBERS | P.VIEW_CHANNEL; // set earlier by someone stronger
    expect(canGrant(actor, current | P.SEND_MESSAGES, current)).toBe(true); // keeps BAN_MEMBERS, adds SEND_MESSAGES
    expect(canGrant(actor, P.VIEW_CHANNEL, current)).toBe(true); // removing bits is fine
    expect(canGrant(actor, current | P.KICK_MEMBERS, current)).toBe(false);
    expect(canGrant(actor, current | P.SEND_MESSAGES)).toBe(false); // without `current`, every bit counts
  });

  it('rejects requests with unknown or invalid bits', () => {
    expect(canGrant(ALL_PERMISSIONS, ALL_PERMISSIONS + 1)).toBe(false);
    expect(canGrant(ALL_PERMISSIONS, -1)).toBe(false);
    expect(canGrant(ALL_PERMISSIONS, 1.5)).toBe(false);
  });
});

describe('voiceSourcesFor (spec §6, LiveKit canPublishSources)', () => {
  it('SPEAK allows the microphone; VIDEO allows camera and screen (with its audio)', () => {
    expect(voiceSourcesFor(P.SPEAK | P.VIDEO, { serverMuted: false })).toEqual(['microphone', 'camera', 'screen_share', 'screen_share_audio']);
    expect(voiceSourcesFor(P.SPEAK, { serverMuted: false })).toEqual(['microphone']);
    expect(voiceSourcesFor(P.VIDEO, { serverMuted: false })).toEqual(['camera', 'screen_share', 'screen_share_audio']);
  });

  it('server mute removes only the microphone', () => {
    expect(voiceSourcesFor(P.SPEAK | P.VIDEO, { serverMuted: true })).toEqual(['camera', 'screen_share', 'screen_share_audio']);
  });

  it('returns an empty list (never "all sources") when nothing may be published', () => {
    expect(voiceSourcesFor(P.SPEAK, { serverMuted: true })).toEqual([]);
    expect(voiceSourcesFor(P.CONNECT_VOICE | P.VIEW_CHANNEL, { serverMuted: false })).toEqual([]);
    expect(voiceSourcesFor(0, { serverMuted: false })).toEqual([]);
  });

  it('follows the effective permissions (administrator and default @everyone)', () => {
    expect(voiceSourcesFor(ALL_PERMISSIONS, { serverMuted: false })).toHaveLength(4);
    expect(voiceSourcesFor(DEFAULT_EVERYONE_PERMISSIONS, { serverMuted: false })).toHaveLength(4);
  });
});
