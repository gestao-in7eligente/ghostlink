// Keeps the connected server's copy of my photo equal to mine (spec 2026-10-01 §4): after
// every welcome whose features include `avatars`, and after every change while connected,
// compare my member's `avatar` with my stored hash and upload or clear when they differ.
// One transfer at a time; a burst of changes sends only the latest. A failure is logged
// (code only) and retried at the next welcome or change. Servers without the flag: nothing.
import { FEATURE_AVATARS, avatarHashSchema, type WelcomePayload } from '@ghostlink/shared';
import { toAppErrorCode } from '../../shared/appErrors.js';
import type { ActiveSession } from '../controller.js';
import type { MyAvatar } from './avatarStore.js';

export interface AvatarSyncDeps {
  store: { current(): MyAvatar | null };
  /** Resolves with the hash the server now holds. */
  upload(session: ActiveSession, bytes: Uint8Array): Promise<string>;
  clear(session: ActiveSession): Promise<void>;
  warn(message: string): void;
}

/** My member's photo in a welcome (the text module's `members`), or null. */
export function myServerAvatar(welcome: WelcomePayload): string | null {
  const members: unknown = (welcome as unknown as Record<string, unknown>).members;
  if (!Array.isArray(members)) return null;
  const me: unknown = members.find((m: unknown) => typeof m === 'object' && m !== null && (m as { userId?: unknown }).userId === welcome.self.userId);
  if (typeof me !== 'object' || me === null) return null;
  const avatar = avatarHashSchema.safeParse((me as { avatar?: unknown }).avatar);
  return avatar.success ? avatar.data : null;
}

export function takesAvatars(session: ActiveSession): boolean {
  return session.welcome.features.includes(FEATURE_AVATARS);
}

export class AvatarSync {
  readonly #deps: AvatarSyncDeps;
  /** The session to keep in step: connected, with the avatars feature. */
  #session: ActiveSession | null = null;
  /** What that session's server holds for me. */
  #serverHash: string | null = null;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(deps: AvatarSyncDeps) {
    this.#deps = deps;
  }

  /** The controller's onSession hook. */
  onSession(session: ActiveSession | null): void {
    this.#session = session !== null && takesAvatars(session) ? session : null;
    this.#serverHash = this.#session === null ? null : myServerAvatar(this.#session.welcome);
    this.#kick();
  }

  /** After setAvatar / clearAvatar. */
  changed(): void {
    this.#kick();
  }

  /** Resolves once nothing is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  #kick(): void {
    if (this.#session === null) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      await this.#reconcile();
    } while (this.#again);
  }

  async #reconcile(): Promise<void> {
    const session = this.#session;
    if (session === null) return;
    const mine = this.#deps.store.current();
    const local = mine?.info.hash ?? null;
    if (local === this.#serverHash) return;
    try {
      const held = mine ? await this.#deps.upload(session, mine.bytes) : (await this.#deps.clear(session), null);
      // Another welcome meanwhile brought its own view of the server: keep that one.
      if (this.#session === session) this.#serverHash = held;
    } catch (e) {
      this.#deps.warn(`[avatars] ${mine ? 'upload' : 'clear'} failed: ${toAppErrorCode(e)}`);
    }
  }
}
