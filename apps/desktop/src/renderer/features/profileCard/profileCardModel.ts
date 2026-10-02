// The profile card (spec 2026-10-02-cartao-de-perfil): what it shows and where it goes, pure so
// it is tested without a DOM.
import { PERMISSIONS, has, type Member, type Role } from '@ghostlink/shared';
import { canActOnMember, manageableRoles, memberRoles, myPermissions } from '../../stores/server.js';
import type { TextState } from '../../stores/textState.js';

// ---- where it goes (spec §1) ----

export const CARD_WIDTH = 340;
/** Between the clicked name (or row) and the card. */
export const CARD_GAP = 8;
/** The card's distance to the window's edges. */
export const CARD_MARGIN = 8;

export interface CardRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The side of the anchor the card prefers: right of a name in the chat, left of the member list. */
export type CardSide = 'right' | 'left';

/**
 * Like Discord: beside the anchor, its top level with the anchor's. A side without room flips to
 * the other one when that one has it; the card is then clamped inside the window.
 */
export function placeCard(anchor: CardRect, size: { width: number; height: number }, viewport: { width: number; height: number }, side: CardSide): { left: number; top: number } {
  const fitsRight = anchor.right + CARD_GAP + size.width <= viewport.width - CARD_MARGIN;
  const fitsLeft = anchor.left - CARD_GAP - size.width >= CARD_MARGIN;
  const preferredFits = side === 'right' ? fitsRight : fitsLeft;
  const otherFits = side === 'right' ? fitsLeft : fitsRight;
  const right = preferredFits || !otherFits ? side === 'right' : side !== 'right';
  const left = right ? anchor.right + CARD_GAP : anchor.left - CARD_GAP - size.width;
  return {
    left: clamp(left, CARD_MARGIN, viewport.width - CARD_MARGIN - size.width),
    top: clamp(anchor.top, CARD_MARGIN, viewport.height - CARD_MARGIN - size.height),
  };
}

/** `min` wins over `max`: a card larger than the window keeps its top-left corner on screen. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// ---- roles (spec §2 item 5) ----

export interface CardRoles {
  /** The person's roles, strongest first (never `@todos`). */
  roles: Role[];
  /** The roles I may take away from them (the × on a chip). */
  removable: ReadonlySet<string>;
  /** The roles I may give them (the "(+)" chip's menu), strongest first. */
  addable: Role[];
}

/**
 * The member menu's rules: MANAGE_ROLES, the person below me (never myself), and only roles below
 * my top role.
 */
export function cardRoles(state: Pick<TextState, 'server' | 'members'>, member: Pick<Member, 'userId' | 'roleIds'>): CardRoles {
  const roles = memberRoles(state.server.roles, member.roleIds);
  if (!canActOnMember(state, member.userId) || !has(myPermissions(state), PERMISSIONS.MANAGE_ROLES)) {
    return { roles, removable: new Set(), addable: [] };
  }
  const manageable = manageableRoles(state);
  const ids = new Set(manageable.map((r) => r.id));
  return {
    roles,
    removable: new Set(roles.filter((r) => ids.has(r.id)).map((r) => r.id)),
    addable: manageable.filter((r) => !member.roleIds.includes(r.id)),
  };
}

/** The role ids to send with `member.setRoles` after giving (or taking) one role. */
export function nextRoleIds(roleIds: readonly string[], roleId: string, give: boolean): string[] {
  if (!give) return roleIds.filter((id) => id !== roleId);
  return roleIds.includes(roleId) ? [...roleIds] : [...roleIds, roleId];
}

// ---- the rest of the card ----

/** "MEMBRO DESDE": "2 de out. de 2026" / "Oct 2, 2026"; null when the server did not say. */
export function formatMemberSince(joinedAt: number, locale: string): string | null {
  if (!Number.isFinite(joinedAt) || joinedAt <= 0) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(joinedAt);
}

/** A pixel counts toward the banner from this alpha on (0–255): transparent corners do not darken it. */
const OPAQUE = 128;

/**
 * The banner's color (spec §2 item 1): the mean of the opaque pixels of RGBA data (a canvas's
 * getImageData), as "#rrggbb"; null when no pixel is opaque (the card then uses the initials' color).
 */
export function averageColor(rgba: ArrayLike<number>): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < OPAQUE) continue;
    r += rgba[i]!;
    g += rgba[i + 1]!;
    b += rgba[i + 2]!;
    n++;
  }
  if (n === 0) return null;
  const hex = (sum: number) => Math.round(sum / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
