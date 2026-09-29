import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  memberBanSchema,
  memberSetRolesSchema,
  parseRoleColor,
  roleColorHex,
  roleCreateSchema,
  roleReorderSchema,
  roleSchemaClient,
  roleUpdateSchema,
} from '../src/index.js';

const ROLE = 'B'.repeat(26);
const USER = 'c'.repeat(32);

describe('role schemas', () => {
  it('role.create accepts known permission bits only', () => {
    expect(roleCreateSchema.safeParse({ name: 'Mod', color: 0x5865f2, permissions: PERMISSIONS.KICK_MEMBERS, hoist: true, mentionable: false }).success).toBe(true);
    expect(roleCreateSchema.safeParse({ name: 'Mod' }).success).toBe(true);
    expect(roleCreateSchema.safeParse({ name: 'Mod', permissions: ALL_PERMISSIONS + 1 }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: 'Mod', permissions: 1 << 30 }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: 'Mod', permissions: -1 }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: 'Mod', permissions: 1.5 }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: 'Mod', color: 0x1000000 }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(roleCreateSchema.safeParse({ name: 'Mod', position: 99 }).success).toBe(false);
  });

  it('role.update needs a well-formed id', () => {
    expect(roleUpdateSchema.safeParse({ id: ROLE, name: 'x' }).success).toBe(true);
    expect(roleUpdateSchema.safeParse({ id: 'nope', name: 'x' }).success).toBe(false);
    expect(roleUpdateSchema.safeParse({ id: ROLE, isDefault: true }).success).toBe(false);
  });

  it('role.reorder and member.setRoles', () => {
    expect(roleReorderSchema.safeParse({ ids: [ROLE] }).success).toBe(true);
    expect(roleReorderSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(memberSetRolesSchema.safeParse({ userId: USER, roleIds: [] }).success).toBe(true);
    expect(memberSetRolesSchema.safeParse({ userId: USER.toUpperCase(), roleIds: [] }).success).toBe(false);
  });

  it('member.ban takes an optional reason and banIp', () => {
    expect(memberBanSchema.safeParse({ userId: USER, reason: 'spam', banIp: true }).success).toBe(true);
    expect(memberBanSchema.safeParse({ userId: USER, reason: 'x'.repeat(513) }).success).toBe(false);
  });

  it('client role schema defaults the optional flags', () => {
    expect(roleSchemaClient.parse({ id: ROLE, name: 'Mod', permissions: 3, position: 2 })).toEqual({
      id: ROLE,
      name: 'Mod',
      color: 0,
      permissions: 3,
      position: 2,
      hoist: false,
      mentionable: false,
      isDefault: false,
    });
  });
});

describe('role colors', () => {
  it('round-trips hex', () => {
    expect(roleColorHex(0x5865f2)).toBe('#5865f2');
    expect(roleColorHex(0x0000ff)).toBe('#0000ff');
    expect(roleColorHex(0)).toBeNull();
    expect(parseRoleColor('#5865F2')).toBe(0x5865f2);
    expect(parseRoleColor('5865f2')).toBeNull();
    expect(parseRoleColor('#5865f2; background:red')).toBeNull();
  });
});
