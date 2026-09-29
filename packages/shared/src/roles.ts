/**
 * Roles and moderation protocol (spec §5.2, §6). The permission math itself
 * lives in permissions.ts; this file only holds the wire types and schemas.
 */
import { z } from 'zod';
import { isPermissionBits } from './permissions.js';

export const ROLE_LIMITS = {
  nameMax: 100,
  maxRoles: 250,
  maxColor: 0xffffff,
} as const;

export interface Role {
  id: string;
  name: string;
  /** 0xRRGGBB; 0 means "no color". */
  color: number;
  permissions: number;
  /** `@everyone` is 0; every other role is >= 1; higher is stronger (spec §6). */
  position: number;
  hoist: boolean;
  mentionable: boolean;
  /** True only for `@everyone` ("@todos"). */
  isDefault: boolean;
}

const roleIdSchema = z.string().regex(/^[A-Z2-7]{26}$/);
const userId = z.string().regex(/^[0-9a-f]{32}$/);
const roleName = z.string().min(1).max(ROLE_LIMITS.nameMax);
const color = z.number().int().min(0).max(ROLE_LIMITS.maxColor);
const permissions = z.number().refine(isPermissionBits);

// ---- server-side (strict) ----

export const roleCreateSchema = z.strictObject({
  name: roleName,
  color: color.optional(),
  permissions: permissions.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

export const roleUpdateSchema = z.strictObject({
  id: roleIdSchema,
  name: roleName.optional(),
  color: color.optional(),
  permissions: permissions.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

export const roleDeleteSchema = z.strictObject({ id: roleIdSchema });
/** The roles to reorder, strongest first; only roles below the actor's top role (spec §5.2). */
export const roleReorderSchema = z.strictObject({ ids: z.array(roleIdSchema).min(1).max(ROLE_LIMITS.maxRoles) });
export const memberSetRolesSchema = z.strictObject({ userId, roleIds: z.array(roleIdSchema).max(ROLE_LIMITS.maxRoles) });
export const memberKickSchema = z.strictObject({ userId });
export const memberBanSchema = z.strictObject({
  userId,
  reason: z.string().max(512).optional(),
  banIp: z.boolean().optional(),
});
export const memberUnbanSchema = z.strictObject({ userId });
export const bansListSchema = z.strictObject({});

// ---- client-side (lenient) ----

export const roleSchemaClient: z.ZodType<Role> = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(256),
  color: z.number().int().min(0).max(ROLE_LIMITS.maxColor).catch(0),
  permissions: z.number().int().min(0),
  position: z.number().int(),
  hoist: z.boolean().catch(false),
  mentionable: z.boolean().catch(false),
  isDefault: z.boolean().catch(false),
});

/** "#rrggbb" for a role color, or null for "no color". */
export function roleColorHex(color: number): string | null {
  if (!Number.isInteger(color) || color <= 0 || color > ROLE_LIMITS.maxColor) return null;
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Parses "#rrggbb" (case-insensitive); null for anything else. */
export function parseRoleColor(hex: string): number | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  return m ? parseInt(m[1]!, 16) : null;
}
