import { randomBytes } from 'node:crypto';
import type { UploadPurpose } from '@ghostlink/shared';

/** What an attachment's upload.begin fixed (spec 2026-10-01-anexos §2). */
export interface AttachmentGrant {
  readonly channelId: string;
  /** Already cleaned (cleanFileName). */
  readonly name: string;
  /** Chosen at upload.begin and answered right away, so msg.send can name it. */
  readonly fileId: string;
}

/** An upload.begin answer waiting for its POST /upload (main spec §4, §7). */
export interface UploadGrant {
  readonly purpose: UploadPurpose;
  readonly sessionId: string;
  readonly userId: string;
  readonly size: number;
  readonly sha256: string;
  readonly expiresAt: number;
  /** Purpose 'attachment' only. */
  readonly attachment?: AttachmentGrant;
}

/** A token is valid this long after upload.begin. */
export const UPLOAD_TOKEN_TTL_MS = 60_000;
/** Unused tokens one session may hold at once (main spec §4: at most 3 uploads per session). */
export const MAX_OPEN_UPLOADS_PER_SESSION = 3;

/**
 * Single-use upload tokens, 256 random bits each, bound to the purpose, session, user, size
 * and hash of their upload.begin. They live only in memory: a restart voids them all.
 * Tokens are secrets: never log them.
 */
export class UploadTokens {
  readonly #grants = new Map<string, UploadGrant>();

  constructor(private readonly now: () => number) {}

  /** Live tokens of this session. */
  open(sessionId: string): number {
    this.sweep();
    let n = 0;
    for (const g of this.#grants.values()) if (g.sessionId === sessionId) n++;
    return n;
  }

  issue(grant: Omit<UploadGrant, 'expiresAt'>): string {
    const token = randomBytes(32).toString('base64url');
    this.#grants.set(token, { ...grant, expiresAt: this.now() + UPLOAD_TOKEN_TTL_MS });
    return token;
  }

  /** Consumes the token: it never works twice. null when unknown or expired. */
  take(token: string): UploadGrant | null {
    const grant = this.#grants.get(token);
    if (!grant) return null;
    this.#grants.delete(token);
    return this.now() > grant.expiresAt ? null : grant;
  }

  /** The session ended: its tokens go with it. */
  dropSession(sessionId: string): void {
    for (const [token, g] of this.#grants) if (g.sessionId === sessionId) this.#grants.delete(token);
  }

  /** Forgets expired tokens (bounded memory). */
  sweep(): void {
    const now = this.now();
    for (const [token, g] of this.#grants) if (now > g.expiresAt) this.#grants.delete(token);
  }
}
