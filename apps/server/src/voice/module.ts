import {
  PERMISSIONS,
  ProtocolError,
  VOICE_LIMITS,
  canActOn,
  channelIdFromRoom,
  has,
  userIdFromIdentity,
  voiceIdentity,
  voiceJoinSchema,
  voiceLeaveSchema,
  voiceModerateSchema,
  voiceRoomName,
  voiceSelfStateSchema,
  type VoiceChannelState,
  type VoiceJoinResponse,
} from '@ghostlink/shared';
import { getMeta } from '../db/serverMeta.js';
import { LivekitBackend, type LivekitParticipant, type VoiceBackend, type VoiceServerOptions, type VoiceWebhookEvent } from '../livekit/backend.js';
import { resolveLivekitBinary } from '../livekit/binary.js';
import { verifyVoiceToken } from '../livekit/jwt.js';
import { createJoinToken, livekitPermission, type LivekitPermission } from '../livekit/permissions.js';
import type { ModuleContext, RequestContext, ServerEvent, ServerModule, SessionInfo } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { NO_CHANNELS, textModuleOf, voiceAccessOf, type TextModuleVoiceSeams, type VoiceAccess } from './access.js';
import { RtcProxy } from './proxy.js';
import { VoiceRegistry } from './registry.js';
import { livekitUrlFor } from './url.js';

const P = PERMISSIONS;
const VIEW_AND_CONNECT = P.VIEW_CHANNEL | P.CONNECT_VOICE;

export interface VoiceModuleOptions {
  /** Test seam: the LiveKit backend (default: livekit-server, or null when its binary is missing). */
  backend?(ctx: ModuleContext, options: VoiceServerOptions): VoiceBackend | null;
  /** VoiceAccess when the text module does not expose one (tests; integration binds Text's). */
  access?(ctx: ModuleContext): VoiceAccess;
  /** Full reconciliation with LiveKit (spec §7: every 60 s). */
  reconcileIntervalMs?: number;
  /** Permission re-check of everyone in voice (safety net behind the Text hooks). */
  sweepIntervalMs?: number;
}

/** The `voice` module plus the calls other modules and tests may make on it. */
export interface VoiceModule extends ServerModule {
  readonly name: 'voice';
  /**
   * Resolves true once LiveKit first answers (a failed first start that the supervisor
   * retries is waited through), false when voice cannot run: no binary, the supervisor
   * gave up, or the server stopped first.
   */
  whenReady(): Promise<boolean>;
  /** Current voice.state of a channel — Text sends it with channel.created to a user who gains access (spec §5.3). */
  channelState(channelId: string): VoiceChannelState;
  /** Re-applies LiveKit permissions for everyone in voice now (after role or channel changes). */
  refreshPermissions(): Promise<void>;
  /** Rebuilds the voice map from LiveKit now (spec §7). */
  reconcile(): Promise<void>;
  /** Takes a user out of voice at once (kick, ban, leave). */
  removeUser(userId: string, opts?: { notify?: boolean }): Promise<void>;
  /** Test/diagnostic view of the in-memory state. */
  readonly registry: VoiceRegistry;
}

function defaultBackend(ctx: ModuleContext, options: VoiceServerOptions): VoiceBackend | null {
  const binaryPath = resolveLivekitBinary({ explicit: options.binaryPath });
  if (!binaryPath) {
    ctx.logger.warn('voice is unavailable: livekit-server was not found (run "node scripts/fetch-livekit.mjs", or set voice.binaryPath / GHOSTLINK_LIVEKIT_BIN)');
    return null;
  }
  return new LivekitBackend({ ...options, binaryPath, dataDir: ctx.dataDir, logger: ctx.logger });
}

function permissionKey(p: LivekitPermission): string {
  return `${p.canPublish}:${[...p.canPublishSources].sort().join(',')}`;
}

/**
 * Voice (spec §8): LiveKit under supervision, voice.join/leave/selfState/moderate,
 * webhook-driven voice.state with per-recipient audience, reconciliation, and the
 * authorized /rtc* proxy on the public HTTPS port.
 */
export function createVoiceModule(opts: VoiceModuleOptions = {}): VoiceModule {
  const registry = new VoiceRegistry();
  const applied = new Map<string, string>();
  let ctx!: ModuleContext;
  let text: TextModuleVoiceSeams | null = null;
  let backend: VoiceBackend | null = null;
  let publicPort = 0;
  let joinLimiter!: SlidingWindowLimiter;
  let ready: Promise<boolean> = Promise.resolve(false);
  let settleReady: (value: boolean) => void = () => {};
  let starting: Promise<unknown> = Promise.resolve();
  const timers: NodeJS.Timeout[] = [];
  const unsubscribe: Array<() => void> = [];
  let stopped = false;
  let reconciling = false;
  let sweeping = false;

  const access = (): VoiceAccess => opts.access?.(ctx) ?? voiceAccessOf(text) ?? NO_CHANNELS;
  const log = (what: string) => (e: unknown) => ctx.logger.warn(`voice: ${what} failed`, { error: String(e) });

  /** Kick, ban and leave end membership (Text); the M1 tables are the source of truth. */
  const inGoodStanding = (userId: string): boolean => {
    const user = ctx.db.get<{ removed_at: number | null }>('SELECT removed_at FROM users WHERE id = ?', userId);
    if (!user || user.removed_at !== null) return false;
    return ctx.db.get('SELECT 1 AS banned FROM bans WHERE user_id = ?', userId) === undefined;
  };

  /** May `userId` be in `channelId`'s room right now? (the /rtc proxy and every LiveKit event). */
  const allowed = (userId: string, channelId: string): boolean => {
    if (registry.assignedChannel(userId) !== channelId) return false;
    if (!ctx.sessions.isOnlineOrInGrace(userId)) return false;
    const a = access();
    const channel = a.channel(channelId);
    if (!channel || channel.type !== 'voice') return false;
    return has(a.permissions(userId, channelId), VIEW_AND_CONNECT) && inGoodStanding(userId);
  };

  /** voice.state goes only to sessions that can see the channel, decided per recipient now (spec §5.3). */
  const broadcast = (channelIds: Iterable<string>): void => {
    for (const channelId of new Set(channelIds)) {
      const event: ServerEvent = { t: 'voice.state', d: registry.state(channelId) };
      ctx.sessions.broadcast(event, (s) => has(access().permissions(s.userId, channelId), P.VIEW_CHANNEL));
    }
  };

  const sendToUser = (userId: string, event: ServerEvent): void => {
    for (const s of ctx.sessions.list()) if (s.userId === userId) ctx.sessions.send(s.sessionId, event);
  };

  const permissionFor = (userId: string, channelId: string): LivekitPermission =>
    livekitPermission(access().permissions(userId, channelId), { serverMuted: registry.isServerMuted(userId) });

  const removeUser = async (userId: string, o: { notify?: boolean } = {}): Promise<void> => {
    const channels = new Set([registry.assignedChannel(userId), registry.channelOf(userId)].filter((c): c is string => c !== null));
    registry.unassign(userId);
    applied.delete(userId);
    broadcast(registry.removeEverywhere(userId));
    if (o.notify) sendToUser(userId, { t: 'voice.forceDisconnect', d: {} });
    if (!backend?.available) return;
    for (const channelId of channels) await backend.removeParticipant(voiceRoomName(channelId), voiceIdentity(userId)).catch(log('removeParticipant'));
  };

  /** Pushes the complete permission block when it changed (spec §8.3); drops users who lost access. */
  const refreshPermissions = async (): Promise<void> => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      for (const [userId, channelId] of registry.assignments()) {
        if (!allowed(userId, channelId)) {
          await removeUser(userId, { notify: ctx.sessions.isOnlineOrInGrace(userId) });
          continue;
        }
        const permission = permissionFor(userId, channelId);
        const key = permissionKey(permission);
        if (applied.get(userId) === key) continue;
        applied.set(userId, key);
        if (backend?.available && registry.channelOf(userId) === channelId) {
          await backend.updatePermission(voiceRoomName(channelId), voiceIdentity(userId), permission).catch(log('updateParticipant'));
        }
      }
    } finally {
      sweeping = false;
    }
  };

  /** Rebuilds presence from LiveKit (spec §7) and removes anyone who should not be there. */
  const reconcile = async (): Promise<void> => {
    if (reconciling || stopped || !backend?.available) return;
    reconciling = true;
    try {
      const b = backend;
      const rooms = new Map<string, Map<string, LivekitParticipant>>();
      for (const room of await b.listRooms()) {
        const channelId = channelIdFromRoom(room);
        if (!channelId) continue;
        for (const p of await b.listParticipants(room)) {
          const userId = userIdFromIdentity(p.identity);
          if (!userId || !allowed(userId, channelId)) {
            await b.removeParticipant(room, p.identity).catch(log('removeParticipant'));
            continue;
          }
          const users = rooms.get(channelId) ?? new Map<string, LivekitParticipant>();
          users.set(userId, p);
          rooms.set(channelId, users);
        }
      }
      if (!stopped) broadcast(registry.replacePresence(rooms));
    } catch (e) {
      log('reconciliation')(e);
    } finally {
      reconciling = false;
    }
  };

  const onWebhook = (e: VoiceWebhookEvent): void => {
    if (stopped || !e.room) return;
    const channelId = channelIdFromRoom(e.room);
    if (!channelId) return;
    if (e.event === 'room_finished') {
      broadcast(registry.clearChannel(channelId));
      return;
    }
    const userId = e.identity ? userIdFromIdentity(e.identity) : null;
    if (!userId || !e.participantSid) {
      // Nobody but our u_<userId> identities may be in our rooms.
      const arriving = e.event === 'participant_joined' || e.event === 'track_published';
      if (arriving && e.identity && backend?.available) void backend.removeParticipant(e.room, e.identity).catch(log('removeParticipant'));
      return;
    }
    switch (e.event) {
      case 'participant_joined':
      case 'track_published':
        if (!allowed(userId, channelId)) {
          if (backend?.available) void backend.removeParticipant(e.room, e.identity!).catch(log('removeParticipant'));
          broadcast(registry.leave(channelId, userId, null));
          return;
        }
        broadcast(e.event === 'participant_joined' || !e.track
          ? registry.join(channelId, userId, e.participantSid)
          : registry.trackPublished(channelId, userId, e.participantSid, e.track));
        return;
      case 'track_unpublished':
        if (e.track) broadcast(registry.trackUnpublished(channelId, userId, e.track.sid));
        return;
      case 'participant_left':
      case 'participant_connection_aborted':
        broadcast(registry.leave(channelId, userId, e.participantSid));
        return;
      default:
        return;
    }
  };

  /** The host:port this client connected to (spec §8.2); a public address only when Host is unusable. */
  const livekitUrl = (rc: RequestContext): string =>
    livekitUrlFor(rc.requestHost, getMeta(ctx.db).publicAddresses[0] ?? `127.0.0.1:${publicPort}`);

  const proxy = new RtcProxy({
    target: () => (backend?.available ? backend.signalPort : null),
    authorize: (token) => {
      if (!token || !backend) return false;
      const claims = verifyVoiceToken(token, { ...backend.keys, nowMs: ctx.now() });
      return claims !== null && allowed(claims.userId, claims.channelId);
    },
  });

  const join = async (rc: RequestContext, payload: unknown): Promise<VoiceJoinResponse | Record<string, never>> => {
    const { channelId } = voiceJoinSchema.parse(payload);
    if (!joinLimiter.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
    const a = access();
    const channel = a.channel(channelId);
    const bits = channel ? a.permissions(rc.userId, channelId) : 0;
    // A channel the user cannot see answers exactly like one that does not exist (spec §5.3).
    if (!channel || !has(bits, P.VIEW_CHANNEL)) throw new ProtocolError('NOT_FOUND');
    if (channel.type !== 'voice') throw new ProtocolError('BAD_REQUEST');
    if (!has(bits, P.CONNECT_VOICE)) throw new ProtocolError('FORBIDDEN');
    if (channel.userLimit > 0 && registry.assignedCount(channelId, rc.userId) >= channel.userLimit) throw new ProtocolError('CHANNEL_FULL');
    if (!backend?.available) {
      ctx.logger.error('voice.join refused: voice is unavailable (LiveKit is missing or not running)');
      throw new ProtocolError('INTERNAL');
    }
    const permission = livekitPermission(bits, { serverMuted: registry.isServerMuted(rc.userId) });
    const nickname = ctx.db.get<{ nickname: string }>('SELECT nickname FROM users WHERE id = ?', rc.userId)?.nickname ?? rc.userId.slice(0, 8);
    const token = await createJoinToken({ ...backend.keys, userId: rc.userId, channelId, nickname, permission });
    if (!rc.isCurrent()) return {};
    const previous = registry.assignedChannel(rc.userId);
    const present = registry.channelOf(rc.userId);
    registry.assign(rc.userId, channelId);
    applied.set(rc.userId, permissionKey(permission));
    broadcast(registry.removeEverywhere(rc.userId, channelId));
    for (const old of new Set([previous, present])) {
      if (old && old !== channelId) void backend.removeParticipant(voiceRoomName(old), voiceIdentity(rc.userId)).catch(log('removeParticipant'));
    }
    return { livekitUrl: livekitUrl(rc), token, iceServers: [] };
  };

  const moderate = async (rc: RequestContext, payload: unknown): Promise<Record<string, never>> => {
    const p = voiceModerateSchema.parse(payload);
    const a = access();
    const current = registry.channelOf(p.userId) ?? registry.assignedChannel(p.userId);
    const actorBits = current ? a.permissions(rc.userId, current) : 0;
    // Someone in a channel the moderator cannot see is "not in voice" for them (spec §5.3).
    if (!current || !has(actorBits, P.VIEW_CHANNEL)) throw new ProtocolError('NOT_FOUND');
    const needed = p.action === 'mute' || p.action === 'unmute' ? P.MUTE_MEMBERS : P.MOVE_MEMBERS;
    if (!has(actorBits, needed)) throw new ProtocolError('FORBIDDEN');
    const subject = (userId: string) => ({ isOwner: a.isOwner(userId), roles: [{ position: a.topPosition(userId) }] });
    if (!canActOn(subject(rc.userId), subject(p.userId))) throw new ProtocolError('HIERARCHY');

    if (p.action === 'mute' || p.action === 'unmute') {
      broadcast(registry.setServerMuted(p.userId, p.action === 'mute'));
      // Enforced by LiveKit: the microphone leaves canPublishSources (never mutePublishedTrack, spec §8.3).
      const permission = permissionFor(p.userId, current);
      applied.set(p.userId, permissionKey(permission));
      if (backend?.available && registry.channelOf(p.userId) === current) {
        await backend.updatePermission(voiceRoomName(current), voiceIdentity(p.userId), permission).catch(log('updateParticipant'));
      }
      return {};
    }
    if (p.action === 'disconnect') {
      await removeUser(p.userId, { notify: true });
      return {};
    }
    const to = p.toChannelId!;
    const target = a.channel(to);
    if (!target || !has(a.permissions(rc.userId, to), P.VIEW_CHANNEL)) throw new ProtocolError('NOT_FOUND');
    if (target.type !== 'voice') throw new ProtocolError('BAD_REQUEST');
    if (!has(a.permissions(p.userId, to), VIEW_AND_CONNECT)) throw new ProtocolError('FORBIDDEN');
    if (to === current) return {};
    if (target.userLimit > 0 && registry.assignedCount(to, p.userId) >= target.userLimit) throw new ProtocolError('CHANNEL_FULL');
    // The client leaves and joins `to` by itself (spec §8.3); the old room is closed to it now.
    registry.unassign(p.userId);
    applied.delete(p.userId);
    broadcast(registry.removeEverywhere(p.userId));
    sendToUser(p.userId, { t: 'voice.forceMove', d: { toChannelId: to } });
    if (backend?.available) await backend.removeParticipant(voiceRoomName(current), voiceIdentity(p.userId)).catch(log('removeParticipant'));
    return {};
  };

  const module: VoiceModule = {
    name: 'voice',
    registry,
    get features(): readonly string[] {
      return backend?.available ? ['voice'] : [];
    },
    handlers: {
      'voice.join': join,
      'voice.leave': async (rc, payload) => {
        voiceLeaveSchema.parse(payload ?? {});
        await removeUser(rc.userId);
        return {};
      },
      'voice.selfState': (rc, payload) => {
        const state = voiceSelfStateSchema.parse(payload);
        broadcast(registry.setSelfState(rc.userId, state));
        return {};
      },
      'voice.moderate': moderate,
    },
    init(c) {
      ctx = c;
      stopped = false;
      text = textModuleOf(c);
      joinLimiter = new SlidingWindowLimiter(VOICE_LIMITS.joinPerWindow, VOICE_LIMITS.joinWindowMs, c.now);
      const onRemoved = text?.onMembershipRemoved?.((userId) => void removeUser(userId, { notify: true }));
      if (onRemoved) unsubscribe.push(onRemoved);
      const onChanged = text?.onPermissionsChanged?.(() => void refreshPermissions());
      if (onChanged) unsubscribe.push(onChanged);
      backend = (opts.backend ?? defaultBackend)(c, c.options?.voice ?? {});
    },
    start({ port }) {
      publicPort = port;
      if (!backend) return;
      const b = backend;
      ready = new Promise<boolean>((resolve) => (settleReady = resolve));
      const first = b.start({
        onReady: () => {
          settleReady(true);
          void reconcile();
        },
        onWebhook,
        onUnavailable: () => {
          settleReady(false);
          ctx.logger.error('voice is unavailable: LiveKit could not be restarted');
        },
      });
      // A failed first start is retried by the supervisor, which ends in onReady or onUnavailable.
      starting = first.catch((e: unknown) => {
        ctx.logger.error('LiveKit did not start; retrying', { error: e instanceof Error ? e.message : String(e) });
      });
      timers.push(setInterval(() => void reconcile(), opts.reconcileIntervalMs ?? 60_000));
      timers.push(setInterval(() => void refreshPermissions(), opts.sweepIntervalMs ?? 5_000));
      for (const t of timers) t.unref();
    },
    async stop() {
      stopped = true;
      settleReady(false);
      for (const t of timers.splice(0)) clearInterval(t);
      for (const off of unsubscribe.splice(0)) off();
      await backend?.stop();
      await starting;
      await backend?.stop();
    },
    welcome(session: SessionInfo) {
      const a = access();
      const voice = registry.channels()
        .filter((channelId) => has(a.permissions(session.userId, channelId), P.VIEW_CHANNEL))
        .map((channelId) => registry.state(channelId));
      return { voice };
    },
    onSessionClosed(session, info) {
      // Within the grace the call goes on (spec §8.4); when it expires the server removes the user.
      if (info.graceExpired) {
        void removeUser(session.userId);
        registry.forget(session.userId);
      }
    },
    http: (req, res) => proxy.http(req, res),
    upgrade: (req, socket, head) => proxy.upgrade(req, socket, head),
    whenReady: () => ready,
    channelState: (channelId) => registry.state(channelId),
    refreshPermissions,
    reconcile,
    removeUser,
  };
  return module;
}
