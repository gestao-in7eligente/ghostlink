import { ProtocolError, type MemberLeftReason, type ServerSettings } from '@ghostlink/shared';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, ServerEvent, SessionInfo } from '../modules.js';
import { Access, type Subject } from './access.js';
import type { TextLimiters } from './rateLimit.js';
import type { ChannelRow, TextRepo } from './repo.js';

/**
 * In-process signals for other server modules (the Voice track subscribes to
 * them through `textModule.events.on(...)`).
 */
export interface TextEventMap {
  /** A member was kicked, banned or left: end their voice session. */
  'membership.removed': { userId: string; reason: MemberLeftReason };
  /**
   * Roles, channel privacy or ownership changed: re-check LiveKit permissions.
   * `userIds: null` means anyone may be affected.
   */
  'access.changed': { userIds: string[] | null };
  /** A channel was deleted (its voice room, if any, must be closed). */
  'channel.deleted': { channelId: string; type: 'text' | 'voice' };
  /**
   * Per-user visibility changed: `gained` channels were just announced with
   * `channel.created`, `lost` ones with `channel.deleted` (spec §5.3). Voice
   * sends `voice.state` for gained voice channels and disconnects lost ones.
   */
  'visibility.changed': { userId: string; gained: string[]; lost: string[] };
}

export type TextEventName = keyof TextEventMap;

export interface TextEvents {
  on<K extends TextEventName>(event: K, listener: (payload: TextEventMap[K]) => void): () => void;
}

export class TextEmitter implements TextEvents {
  readonly #listeners = new Map<TextEventName, Set<(payload: never) => void>>();

  constructor(private readonly onError: (event: string, error: unknown) => void) {}

  on<K extends TextEventName>(event: K, listener: (payload: TextEventMap[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }

  emit<K extends TextEventName>(event: K, payload: TextEventMap[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as (p: TextEventMap[K]) => void)(payload);
      } catch (e) {
        this.onError(event, e);
      }
    }
  }
}

/** Shared state of the text module, handed to every request handler. */
export class TextCore {
  readonly access: Access;
  /** Users with a session or inside the presence grace (spec §5.1). */
  readonly online = new Set<string>();
  /** Current members as last announced, to tell a (re)join apart from a reconnect. */
  readonly knownMembers = new Set<string>();
  port = 0;

  constructor(
    readonly ctx: ModuleContext,
    readonly repo: TextRepo,
    readonly limiters: TextLimiters,
    readonly events: TextEmitter,
  ) {
    this.access = new Access(repo);
  }

  get db() {
    return this.ctx.db;
  }

  now(): number {
    return this.ctx.now();
  }

  /** The caller as a permission subject; FORBIDDEN once they are no longer a member (kick/leave race). */
  member(userId: string): Subject {
    const subject = this.access.subject(userId);
    if (!subject.isMember) throw new ProtocolError('FORBIDDEN');
    return subject;
  }

  isOnline = (userId: string): boolean => this.online.has(userId);

  serverSettings(): ServerSettings {
    const meta = getMeta(this.db);
    return { ownerId: meta.ownerUserId, maxMembers: meta.maxMembers, hasPassword: meta.passwordHash !== null };
  }

  /**
   * Membership, presence, role and server events go to every member (spec §5.3).
   * A session whose membership just ended (it is closing) gets nothing more.
   */
  broadcastAll(event: ServerEvent, except?: string): void {
    this.ctx.sessions.broadcast(event, (s) => s.userId !== except && this.repo.isMember(s.userId));
  }

  /**
   * Channel events reach only members with VIEW_CHANNEL in that channel,
   * computed per recipient at send time (spec §5.3).
   */
  broadcastChannel(channel: ChannelRow, event: ServerEvent, except?: string): void {
    const access = this.access.channelAccess(channel);
    this.ctx.sessions.broadcast(event, (s) => s.userId !== except && this.access.canView(s.userId, channel, access));
  }

  /**
   * Runs a synchronous mutation that may change who sees which channel, then
   * sends `channel.deleted` to every online user who lost a channel and
   * `channel.created` (with the read state) to every one who gained one.
   * Returns the per-user visibility before and after, for `channel.updated`.
   */
  withVisibility<T>(mutate: () => T): { result: T; before: Map<string, Set<string>>; after: Map<string, Set<string>> } {
    const sessions = this.ctx.sessions.list();
    const snapshot = () => new Map(sessions.map((s): [string, Set<string>] => [s.userId, this.access.visibleChannelIds(s.userId)]));
    const before = snapshot();
    const result = mutate();
    const after = snapshot();
    for (const s of sessions) this.#announceVisibility(s, before.get(s.userId)!, after.get(s.userId)!);
    return { result, before, after };
  }

  #announceVisibility(session: SessionInfo, before: Set<string>, after: Set<string>): void {
    const lost = [...before].filter((id) => !after.has(id));
    const gained = [...after].filter((id) => !before.has(id));
    for (const id of lost) this.ctx.sessions.send(session.sessionId, { t: 'channel.deleted', d: { id } });
    if (gained.length > 0) {
      const reads = new Map(this.repo.readStates(session.userId, gained).map((r) => [r.channelId, r]));
      for (const id of gained) {
        const row = this.repo.channel(id);
        if (!row) continue;
        this.ctx.sessions.send(session.sessionId, { t: 'channel.created', d: { channel: this.repo.toChannel(row), readState: reads.get(id) } });
      }
    }
    if (lost.length > 0 || gained.length > 0) this.events.emit('visibility.changed', { userId: session.userId, gained, lost });
  }
}
