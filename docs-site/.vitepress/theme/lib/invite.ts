// The /j/ invite page (spec §3.5). A web invite is `${site}/j/#GL1-…`: the invite lives in the
// fragment, which the browser never sends to any server, so only this script ever sees it.
// The app's own parser, imported module by module so the page does not bundle all of @ghostlink/shared.
import { CRYPTO_LABELS, LIMITS } from '../../../../packages/shared/src/constants.js';
import { formatInviteLink, formatPasteCode, parseJoinInput } from '../../../../packages/shared/src/invite.js';

/** How long the page waits for the app to take the ghostlink:// link before offering the download. */
export const OPEN_APP_TIMEOUT_MS = 1500;

/**
 * Whether the page may navigate to ghostlink:// on its own. Chromium browsers (Chrome, Edge, Opera,
 * Brave) ask "Open GhostLink?" when the app is installed and silently ignore the link when it is
 * not; Firefox replaces the page with an error, so there the visitor clicks "Open in GhostLink".
 */
export function canTryAppLinkOnLoad(userAgent: string): boolean {
  return !/\bFirefox\//.test(userAgent);
}

export interface WebInvite {
  /** `ghostlink://join?…`, rebuilt from the parsed invite (never the raw fragment). */
  deepLink: string;
  /** The canonical `GL1-…` code, to paste into the app after installing it. */
  pasteCode: string;
  /** The server name the invite suggests (already cleaned), or null. */
  name: string | null;
  /** Normalized `host:port` routes to the server. */
  addresses: string[];
}

/**
 * Turns `location.hash` into an invite, or null when it holds anything but a valid `GL1-` code.
 * The same parser as the app's "Join" screen validates it (addresses, server key, code, name),
 * and both outputs are re-encoded from the parsed result.
 */
export function inviteFromFragment(hash: string): WebInvite | null {
  if (typeof hash !== 'string' || hash.length > LIMITS.inviteMaxLength * 3) return null;
  let code = hash.startsWith('#') ? hash.slice(1) : hash;
  // Some chat apps percent-encode fragments; a GL1- code itself never needs it.
  if (code.includes('%')) {
    try {
      code = decodeURIComponent(code);
    } catch {
      return null;
    }
  }
  code = code.trim();
  if (!code.startsWith(CRYPTO_LABELS.pastePrefix)) return null;
  try {
    const parsed = parseJoinInput(code);
    if (parsed.kind !== 'invite') return null;
    const { invite } = parsed;
    const deepLink = formatInviteLink(invite);
    if (!deepLink.startsWith(`${CRYPTO_LABELS.scheme}://join?`)) return null;
    return {
      deepLink,
      pasteCode: formatPasteCode(invite),
      name: invite.name ?? null,
      addresses: [...invite.addresses],
    };
  } catch {
    return null;
  }
}
