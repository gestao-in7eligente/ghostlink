import type { ErrorCode } from '@ghostlink/shared';

export interface SessionHandle {
  readonly userId: string;
  readonly sessionId: string;
  terminate(code: ErrorCode): void;
}

/** One live session per identity: a new login replaces the old one with SESSION_REPLACED (spec §3.3). */
export class SessionRegistry {
  readonly #byUser = new Map<string, SessionHandle>();

  add(session: SessionHandle): void {
    const previous = this.#byUser.get(session.userId);
    this.#byUser.set(session.userId, session);
    if (previous && previous !== session) previous.terminate('SESSION_REPLACED');
  }

  /** Removes the session only if it is still the current one for its user. */
  remove(session: SessionHandle): void {
    if (this.#byUser.get(session.userId) === session) this.#byUser.delete(session.userId);
  }

  isCurrent(session: SessionHandle): boolean {
    return this.#byUser.get(session.userId) === session;
  }

  get(userId: string): SessionHandle | undefined {
    return this.#byUser.get(userId);
  }

  get size(): number {
    return this.#byUser.size;
  }
}
