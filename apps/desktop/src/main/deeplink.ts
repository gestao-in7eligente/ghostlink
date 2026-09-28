// ghostlink:// links (spec §12): registration, argv extraction (first launch and
// second-instance), macOS open-url, validation, and delivery to the renderer. A link
// never connects by itself: the renderer shows the invite (the name is only a hint
// from the link) and the person accepts it.
import { resolve } from 'node:path';
import { z } from 'zod';
import { CRYPTO_LABELS, LIMITS, parseJoinInput, type ParsedJoinInput } from '@ghostlink/shared';

export const DEEP_LINK_SCHEME = CRYPTO_LABELS.scheme;

export type DeepLinkInvite = Extract<ParsedJoinInput, { kind: 'invite' }>;

const PREFIX = new RegExp(`^${DEEP_LINK_SCHEME}://`, 'i');
/** 2 KB in total; the address count (≤ 8) and ports (1..65535) are checked by parseJoinInput. */
const linkSchema = z.string().max(LIMITS.inviteMaxLength).regex(PREFIX);

/** The argv item that is a ghostlink:// link (Chromium may add flags around it), or null. */
export function extractDeepLink(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && PREFIX.test(arg)) return linkSchema.safeParse(arg).success ? arg : null;
  }
  return null;
}

/** A validated invite from a ghostlink:// link, or null (GL1- codes and web links are not links). */
export function parseDeepLink(value: unknown): DeepLinkInvite | null {
  const parsed = linkSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const result = parseJoinInput(parsed.data);
    return result.kind === 'invite' ? result : null;
  } catch {
    return null;
  }
}

/**
 * Holds the latest link until the page asks for it (first launch: the link arrives
 * before the renderer listens), then forwards new links as events.
 */
export class DeepLinks {
  readonly #send: (invite: DeepLinkInvite) => void;
  readonly #log: (message: string) => void;
  #pending: DeepLinkInvite | null = null;
  #rendererReady = false;

  constructor(opts: { send: (invite: DeepLinkInvite) => void; log: (message: string) => void }) {
    this.#send = opts.send;
    this.#log = opts.log;
  }

  handle(url: string | null | undefined): void {
    if (url === null || url === undefined) return;
    const invite = parseDeepLink(url);
    if (invite === null) {
      this.#log('ignored an invalid ghostlink:// link'); // never log the link: it carries an invite code
      return;
    }
    if (this.#rendererReady) this.#send(invite);
    else this.#pending = invite;
  }

  /** The page calls this once it listens: returns the link that arrived before, if any. */
  take(): DeepLinkInvite | null {
    this.#rendererReady = true;
    const pending = this.#pending;
    this.#pending = null;
    return pending;
  }
}

/**
 * spec §12: HKCU registration on Windows (no admin). In development it would point the
 * scheme at the dev Electron and take it away from an installed GhostLink, so it only
 * happens there with GHOSTLINK_REGISTER_PROTOCOL=1 (args = the app path).
 */
export function registerProtocolClient(
  app: { isPackaged: boolean; setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean },
  opts: { argv: readonly string[]; execPath: string; env: NodeJS.ProcessEnv },
): boolean {
  if (app.isPackaged) return app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, opts.execPath, []);
  if (opts.env.GHOSTLINK_REGISTER_PROTOCOL !== '1' || !opts.argv[1]) return false;
  return app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, opts.execPath, [resolve(opts.argv[1])]);
}
