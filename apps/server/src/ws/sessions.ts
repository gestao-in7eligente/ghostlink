import type { ErrorCode } from '@ghostlink/shared';

export interface SessionHandle {
  readonly userId: string;
  readonly sessionId: string;
  /** The welcome's fileToken (spec §7); see SessionsApi.fileToken. */
  readonly fileToken?: string;
  send(event: object): void;
  terminate(code: ErrorCode): void;
}

/** One live session per identity: a new login replaces the old one with SESSION_REPLACED (spec §3.3). */
export class SessionRegistry {
  readonly #byUser = new Map<string, SessionHandle>();
  readonly #bySession = new Map<string, SessionHandle>();

  add(session: SessionHandle): void {
    const previous = this.#byUser.get(session.userId);
    if (previous && previous !== session) this.#bySession.delete(previous.sessionId);
    this.#byUser.set(session.userId, session);
    this.#bySession.set(session.sessionId, session);
    if (previous && previous !== session) previous.terminate('SESSION_REPLACED');
  }

  /** Removes the session only if it is still the current one for its user. */
  remove(session: SessionHandle): void {
    if (this.#byUser.get(session.userId) !== session) return;
    this.#byUser.delete(session.userId);
    this.#bySession.delete(session.sessionId);
  }

  isCurrent(session: SessionHandle): boolean {
    return this.#byUser.get(session.userId) === session;
  }

  get(userId: string): SessionHandle | undefined {
    return this.#byUser.get(userId);
  }

  getBySession(sessionId: string): SessionHandle | undefined {
    return this.#bySession.get(sessionId);
  }

  list(): SessionHandle[] {
    return [...this.#byUser.values()];
  }

  get size(): number {
    return this.#byUser.size;
  }
}
