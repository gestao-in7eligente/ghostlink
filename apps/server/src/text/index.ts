import { CHAT_LIMITS, type TextWelcome } from '@ghostlink/shared';
import type { ModuleContext, RequestContext, RequestHandler, ServerModule, SessionInfo } from '../modules.js';
import { TextCore, TextEmitter, type TextEvents } from './core.js';
import { channelHandlers } from './handlers/channels.js';
import { memberHandlers } from './handlers/members.js';
import { messageHandlers } from './handlers/messages.js';
import { roleHandlers } from './handlers/roles.js';
import { serverHandlers } from './handlers/server.js';
import { DEFAULT_TEXT_RATE_LIMITS, TextLimiters, type TextRateLimits } from './rateLimit.js';
import { TextRepo, toRole } from './repo.js';
import { seedDefaults } from './seed.js';

export type { TextEventMap, TextEventName, TextEvents } from './core.js';
export type { TextRateLimits } from './rateLimit.js';

export const TEXT_MODULE_NAME = 'text';

/**
 * What the Voice module needs from the text module (release plan "Seams").
 * Every answer is read fresh from the database.
 */
export interface VoiceAccess {
  channel(channelId: string): { type: 'text' | 'voice'; userLimit: number } | null;
  /** Effective bits inside the channel, private-channel rules included; 0 if not visible or not a member. */
  permissions(userId: string, channelId: string): number;
  isOwner(userId: string): boolean;
  /** Highest role position, for voice.moderate hierarchy checks; the owner gets Number.MAX_SAFE_INTEGER. */
  topPosition(userId: string): number;
}

export interface TextModule extends ServerModule {
  readonly name: typeof TEXT_MODULE_NAME;
  /** In-process signals: `membership.removed`, `access.changed`, `channel.deleted`, `visibility.changed`. */
  readonly events: TextEvents;
  /** Usable once the server started (after init). */
  readonly voiceAccess: VoiceAccess;
  /**
   * Sends `member.updated` with the member as stored now to every member (spec §5.3), as
   * profile.update does; nothing when `userId` is not a member. For modules that change a
   * users column the member carries (the avatars module's `avatar_file_id`).
   */
  announceMember(userId: string): void;
  /** Server-wide permission bits of a member; 0 for anyone else (the avatars module's server icon). */
  serverPermissions(userId: string): number;
  /** Sends `server.updated` as stored now to every member, as server.update does (the server icon). */
  announceServer(): void;
}

export interface TextModuleOptions {
  /** Tests only: shrink the spec §13 limits. */
  rateLimits?: Partial<TextRateLimits>;
  /** Tests only: fewer channels than CHAT_LIMITS.maxChannels. */
  maxChannels?: number;
}

/** The Voice track's entry point: `getVoiceAccess(ctx)` inside its own init/handlers. */
export function getVoiceAccess(ctx: Pick<ModuleContext, 'getModule'>): VoiceAccess {
  return ctx.getModule<TextModule>(TEXT_MODULE_NAME).voiceAccess;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Text, roles and moderation (spec §5–§7) as a server module. Register it with
 * `createTextModule()` in defaultModules(), before any module that calls
 * getVoiceAccess() in its init.
 */
export function createTextModule(opts: TextModuleOptions = {}): TextModule {
  let core: TextCore | null = null;
  let sweep: NodeJS.Timeout | null = null;
  const events = new TextEmitter((event, error) => core?.ctx.logger.error('text event listener failed', { event, error: String(error) }));

  const need = (): TextCore => {
    if (!core) throw new Error('the text module is not initialized');
    return core;
  };

  const handlers: Record<string, RequestHandler> = {};
  for (const group of [channelHandlers, messageHandlers, roleHandlers, memberHandlers, serverHandlers]) {
    for (const [type, handler] of Object.entries(group)) {
      handlers[type] = (ctx: RequestContext, payload: unknown) => handler(need(), ctx, payload);
    }
  }

  const voiceAccess: VoiceAccess = {
    channel: (channelId) => {
      const row = need().repo.channel(channelId);
      return row ? { type: row.type, userLimit: Number(row.user_limit) } : null;
    },
    permissions: (userId, channelId) => {
      const c = need();
      const row = c.repo.channel(channelId);
      return row ? c.access.channelPerms(c.access.subject(userId), row) : 0;
    },
    isOwner: (userId) => need().access.subject(userId).isOwner,
    topPosition: (userId) => need().access.topPosition(userId),
  };

  const welcome = (session: SessionInfo): TextWelcome => {
    const c = need();
    const subject = c.access.subject(session.userId);
    const channels = c.repo.channels().filter((ch) => c.access.channelPerms(subject, ch) !== 0).map((ch) => c.repo.toChannel(ch));
    const textIds = channels.filter((ch) => ch.type === 'text').map((ch) => ch.id);
    return {
      channels,
      roles: c.repo.roles().map(toRole),
      // The welcome is built before onSessionOpened, so the user counts as online already.
      members: c.repo.members((id) => id === session.userId || c.online.has(id)),
      readStates: c.repo.readStates(session.userId, textIds),
      serverSettings: c.serverSettings(),
    };
  };

  return {
    name: TEXT_MODULE_NAME,
    features: ['text'],
    handlers,
    events,
    voiceAccess,

    announceMember(userId) {
      const c = need();
      const member = c.repo.member(userId, c.isOnline(userId));
      if (member) c.broadcastAll({ t: 'member.updated', d: { member } });
    },

    serverPermissions(userId) {
      const c = need();
      return c.access.serverPerms(c.access.subject(userId));
    },

    announceServer() {
      const c = need();
      c.broadcastAll({ t: 'server.updated', d: c.serverInfo() });
    },

    init(ctx) {
      seedDefaults(ctx.db, ctx.now());
      const repo = new TextRepo(ctx.db);
      core = new TextCore(ctx, repo, new TextLimiters({ ...DEFAULT_TEXT_RATE_LIMITS, ...opts.rateLimits }, ctx.now), events);
      core.maxChannels = opts.maxChannels ?? CHAT_LIMITS.maxChannels;
      for (const id of repo.memberIds()) core.knownMembers.add(id);
      const limiters = core.limiters;
      sweep = setInterval(() => limiters.sweep(), SWEEP_INTERVAL_MS);
      sweep.unref();
    },

    start({ port }) {
      need().port = port;
    },

    stop() {
      if (sweep) clearInterval(sweep);
      sweep = null;
    },

    welcome: (session) => ({ ...welcome(session) }),

    onSessionOpened(session) {
      const c = need();
      const { userId } = session;
      if (!c.knownMembers.has(userId)) {
        // A new identity, or a former member who came back through the join mode.
        c.knownMembers.add(userId);
        const member = c.repo.member(userId, true);
        if (member) c.broadcastAll({ t: 'member.joined', d: { member } }, userId);
      }
      if (!c.online.has(userId)) {
        c.online.add(userId);
        c.broadcastAll({ t: 'presence', d: { userId, online: true } }, userId);
      }
    },

    onSessionClosed(session, info) {
      const c = need();
      // Offline only once the presence grace is over (spec §5.1), or at once after a kick or ban.
      if (!info.graceExpired || !c.online.delete(session.userId)) return;
      c.broadcastAll({ t: 'presence', d: { userId: session.userId, online: false } });
    },
  };
}
