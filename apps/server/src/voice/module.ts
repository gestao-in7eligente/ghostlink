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
import {
  LivekitBackend,
  type LivekitParticipant,
  type VoiceBackend,
  type VoiceBackendListeners,
  type VoiceServerOptions,
  type VoiceWebhookEvent,
} from '../livekit/backend.js';
import { resolveLivekitBinary } from '../livekit/binary.js';
import { verifyVoiceToken } from '../livekit/jwt.js';
import { createJoinToken, livekitPermission, type LivekitPermission } from '../livekit/permissions.js';
import type { ModuleContext, RequestContext, ServerEvent, ServerModule, SessionInfo } from '../modules.js';
import { describeNodeIp, fallbackNodeIp, type NodeIpChoice } from '../net/addresses.js';
import { NET_MODULE, type NetModule } from '../net/netModule.js';
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
  /**
   * How long start() waits for LiveKit's first answer, so the first welcomes (the host's
   * own app connects right after startup) already list voice. Default 5 s; 0: no wait.
   */
  readyWaitMs?: number;
  /**
   * At most this long, start() waits for the `net` module's first UPnP answer before
   * LiveKit's config is written, so the router's WAN IP is usually known (spec §8.1). Default 8 s.
   */
  netWaitMs?: number;
  /** How often the `net` module's node IP is compared with the one LiveKit announces. Default 5 s. */
  nodeIpCheckIntervalMs?: number;
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
  /** The IP LiveKit announces to clients (rtc.node_ip); null until LiveKit is first started. */
  readonly nodeIp: string | null;
  /**
   * Compares the `net` module's node IP with the one LiveKit announces (spec §8.1). When it
   * changed, LiveKit restarts with it now if nobody is in voice, else as soon as the rooms
   * are empty. Resolves once a restart it started is done. Runs on a timer as well.
   */
  refreshNodeIp(): Promise<void>;
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

/** The `net` module when this server runs one (the CLI and Host mode do), else null. */
function netModuleOf(ctx: ModuleContext): NetModule | null {
  try {
    return ctx.getModule<NetModule>(NET_MODULE);
  } catch {
    return null;
  }
}

/** Resolves when `p` settles or after `ms`, whichever comes first. */
async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
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
  /** What LiveKit was last told per user: to which connection (participant sid), and which block. */
  const applied = new Map<string, { sid: string; key: string }>();
  /** The permission push in progress per user (pushes are serialized per user). */
  const pushes = new Map<string, Promise<void>>();
  let ctx!: ModuleContext;
  let text: TextModuleVoiceSeams | null = null;
  let net: NetModule | null = null;
  let backend: VoiceBackend | null = null;
  /** The node_ip LiveKit announces (spec §8.1); null until LiveKit is first started. */
  let nodeIp: string | null = null;
  /** A new node_ip that waits for the rooms to empty. */
  let pendingNodeIp: NodeIpChoice | null = null;
  /** The LiveKit restart for a new node_ip in progress. */
  let restarting: Promise<void> | null = null;
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
  let sweepAgain = false;
  /** Whether sessions were last told voice is available (welcome.features, then voice.availability). */
  let announced = false;

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

  /** A user who just gained voice channels gets their voice.state with channel.created (spec §5.3). */
  const sendGained = (userId: string, channelIds: readonly string[]): void => {
    const a = access();
    for (const channelId of channelIds) {
      if (a.channel(channelId)?.type !== 'voice' || !has(a.permissions(userId, channelId), P.VIEW_CHANNEL)) continue;
      sendToUser(userId, { t: 'voice.state', d: registry.state(channelId) });
    }
  };

  /**
   * `voice.availability` to every session when LiveKit comes or goes (first start, crash,
   * restart, gave up): welcome.features is only read when a session opens. A server-wide
   * flag, like features itself, so it has no channel audience. While LiveKit is down
   * nobody is connected to it: the voice map empties (a restart rebuilds it, spec §7).
   */
  const announce = (): void => {
    const available = !stopped && backend?.available === true;
    if (!available) broadcast(registry.replacePresence(new Map()));
    if (available === announced) return;
    announced = available;
    ctx.sessions.broadcast({ t: 'voice.availability', d: { available } });
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
    if (backend?.available) {
      for (const channelId of channels) await backend.removeParticipant(voiceRoomName(channelId), voiceIdentity(userId)).catch(log('removeParticipant'));
    }
    applyPendingNodeIp();
  };

  /** The explicit node_ip (CLI --node-ip, voice.nodeIp): it never changes. */
  const explicitNodeIp = (): string | undefined => ctx.options?.voice?.nodeIp || undefined;

  /**
   * The IP LiveKit should announce, and why (spec §8.1): the explicit one, else the `net`
   * module's (the router's public WAN IP from UPnP, else its best reachable local address),
   * else this machine's best address (a public interface IP, a LAN one, a VPN one) or 127.0.0.1.
   */
  const wantedNodeIp = (): NodeIpChoice => {
    const explicit = explicitNodeIp();
    if (explicit) return { ip: explicit, source: 'explicit' };
    return net?.nodeIpChoice() ?? fallbackNodeIp();
  };

  /** Nobody in a LiveKit room and nobody holding a join (about to connect): a restart drops no one. */
  const idle = (): boolean => registry.channels().length === 0 && registry.assignments().length === 0;

  const refreshNodeIp = async (): Promise<void> => {
    if (restarting) return restarting;
    // Only the net module's answer moves: a late UPnP answer, a new WAN IP, a VPN that connects.
    if (stopped || !backend || nodeIp === null || !net || explicitNodeIp()) return;
    const wanted = wantedNodeIp();
    if (wanted.ip === nodeIp) {
      pendingNodeIp = null;
      return;
    }
    // A restart drops every call: it waits until nobody is in voice (and LiveKit is up).
    if (!idle() || !backend.available) {
      if (pendingNodeIp?.ip !== wanted.ip) {
        ctx.logger.info(`voice: the node IP is now ${wanted.ip} (${describeNodeIp(wanted)}); LiveKit restarts with it once nobody is in voice`);
      }
      pendingNodeIp = wanted;
      return;
    }
    pendingNodeIp = null;
    ctx.logger.info(`voice: restarting LiveKit to announce ${wanted.ip} (${describeNodeIp(wanted)}) instead of ${nodeIp}`);
    nodeIp = wanted.ip;
    // Clients hear voice.availability false, then true (onDown, onReady -> announce()).
    restarting = backend
      .restart({ nodeIp: wanted.ip })
      .catch((e: unknown) => {
        if (!stopped) ctx.logger.error('LiveKit did not restart; retrying', { error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        restarting = null;
      });
    await restarting;
  };

  /** A node_ip change that waited for the rooms to empty goes in as soon as they are. */
  const applyPendingNodeIp = (): void => {
    if (pendingNodeIp && !restarting && idle()) void refreshNodeIp();
  };

  const pushPermission = async (userId: string): Promise<void> => {
    const channelId = registry.assignedChannel(userId);
    const sid = channelId ? registry.sidIn(channelId, userId) : null;
    // Not in LiveKit (yet): there is nobody to tell. Their arrival pushes the block then.
    if (stopped || !channelId || !sid || !backend?.available) return;
    const permission = permissionFor(userId, channelId);
    const key = permissionKey(permission);
    const last = applied.get(userId);
    if (last?.sid === sid && last.key === key) return;
    try {
      await backend.updatePermission(voiceRoomName(channelId), voiceIdentity(userId), permission);
      if (registry.sidIn(channelId, userId) === sid) applied.set(userId, { sid, key });
    } catch (e) {
      log('updateParticipant')(e);
    }
  };

  /**
   * Brings LiveKit in line with the user's current permissions (spec §8.3): the complete
   * block, sent to the connection LiveKit reports. A token grants what was true when it
   * was minted, so each new connection gets the block once, and later only changes.
   * Serialized per user and computed when it runs: an earlier push never lands last.
   */
  const syncPermission = (userId: string): Promise<void> => {
    const run = (pushes.get(userId) ?? Promise.resolve()).then(() => pushPermission(userId));
    pushes.set(userId, run);
    void run.then(() => {
      if (pushes.get(userId) === run) pushes.delete(userId);
    });
    return run;
  };

  /** Pushes the complete permission block when it changed (spec §8.3); drops users who lost access. */
  const refreshPermissions = async (): Promise<void> => {
    if (stopped) return;
    // A change that arrives mid-sweep may come after its user was checked: sweep again.
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        for (const [userId, channelId] of registry.assignments()) {
          if (!allowed(userId, channelId)) {
            await removeUser(userId, { notify: ctx.sessions.isOnlineOrInGrace(userId) });
            continue;
          }
          await syncPermission(userId);
        }
      } while (sweepAgain && !stopped);
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
      if (stopped) return;
      broadcast(registry.replacePresence(rooms));
      // Participants whose webhook was lost never got their block (their token may predate a change).
      await Promise.all([...rooms.values()].flatMap((users) => [...users.keys()].map(syncPermission)));
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
      applyPendingNodeIp();
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
        // A mute or permission change since their token was minted reaches LiveKit now.
        void syncPermission(userId);
        return;
      case 'track_unpublished':
        if (e.track) broadcast(registry.trackUnpublished(channelId, userId, e.track.sid));
        return;
      case 'participant_left':
      case 'participant_connection_aborted':
        broadcast(registry.leave(channelId, userId, e.participantSid));
        applyPendingNodeIp();
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
    const unavailable = (): never => {
      ctx.logger.error('voice.join refused: voice is unavailable (LiveKit is missing, not running or restarting)');
      throw new ProtocolError('INTERNAL');
    };
    if (!backend?.available || restarting) return unavailable();
    const permission = livekitPermission(bits, { serverMuted: registry.isServerMuted(rc.userId) });
    const nickname = ctx.db.get<{ nickname: string }>('SELECT nickname FROM users WHERE id = ?', rc.userId)?.nickname ?? rc.userId.slice(0, 8);
    const token = await createJoinToken({ ...backend.keys, userId: rc.userId, channelId, nickname, permission });
    if (!rc.isCurrent()) return {};
    // A node_ip restart may have begun meanwhile: this token would lead nowhere.
    if (!backend.available || restarting) return unavailable();
    const previous = registry.assignedChannel(rc.userId);
    const present = registry.channelOf(rc.userId);
    registry.assign(rc.userId, channelId);
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
      // Not in LiveKit yet: the block goes out when they arrive (participant_joined).
      await syncPermission(p.userId);
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
      net = netModuleOf(c);
      joinLimiter = new SlidingWindowLimiter(VOICE_LIMITS.joinPerWindow, VOICE_LIMITS.joinWindowMs, c.now);
      const onRemoved = text?.onMembershipRemoved?.((userId) => void removeUser(userId, { notify: true }));
      if (onRemoved) unsubscribe.push(onRemoved);
      const onChanged = text?.onPermissionsChanged?.(() => void refreshPermissions());
      if (onChanged) unsubscribe.push(onChanged);
      const events = text?.events;
      if (events && typeof events.on === 'function') {
        const userIdIn = (p: unknown): string | null => {
          const userId = (p as { userId?: unknown } | null)?.userId;
          return typeof userId === 'string' && /^[0-9a-f]{32}$/.test(userId) ? userId : null;
        };
        unsubscribe.push(
          events.on('membership.removed', (p: unknown) => {
            const userId = userIdIn(p);
            if (userId) void removeUser(userId, { notify: true });
          }),
          events.on('access.changed', () => void refreshPermissions()),
          events.on('channel.deleted', () => void refreshPermissions()),
          events.on('visibility.changed', (p: unknown) => {
            const userId = userIdIn(p);
            const gained = (p as { gained?: unknown }).gained;
            if (!userId || !Array.isArray(gained)) return;
            sendGained(userId, gained.filter((c): c is string => typeof c === 'string'));
            void refreshPermissions();
          }),
        );
      }
      backend = (opts.backend ?? defaultBackend)(c, c.options?.voice ?? {});
      announced = backend?.available === true;
    },
    async start({ port }) {
      publicPort = port;
      if (!backend) return;
      const b = backend;
      ready = new Promise<boolean>((resolve) => (settleReady = resolve));
      const listeners: VoiceBackendListeners = {
        onReady: () => {
          settleReady(true);
          announce();
          void reconcile();
        },
        onWebhook,
        onDown: () => announce(),
        onUnavailable: () => {
          settleReady(false);
          announce();
          ctx.logger.error('voice is unavailable: LiveKit could not be restarted');
        },
      };
      const following = net !== null && !explicitNodeIp() ? net : null;
      // spec §8.1: once UPnP first answered, the router's WAN IP is known; LiveKit's config
      // is written after that (bounded). A later change goes through refreshNodeIp().
      const chosen = (async () => {
        if (following) await waitAtMost(following.ready().catch(() => {}), opts.netWaitMs ?? 8_000);
        return wantedNodeIp();
      })();
      // A failed first start is retried by the supervisor, which ends in onReady or onUnavailable.
      starting = chosen
        .then((choice) => {
          if (stopped) return;
          nodeIp = choice.ip;
          ctx.logger.info(`voice: LiveKit announces ${choice.ip} to clients (${describeNodeIp(choice)})`);
          return b.start(listeners, { nodeIp: choice.ip });
        })
        .catch((e: unknown) => {
          ctx.logger.error('LiveKit did not start; retrying', { error: e instanceof Error ? e.message : String(e) });
        });
      timers.push(setInterval(() => void reconcile(), opts.reconcileIntervalMs ?? 60_000));
      timers.push(setInterval(() => void refreshPermissions(), opts.sweepIntervalMs ?? 5_000));
      if (following) timers.push(setInterval(() => void refreshNodeIp(), opts.nodeIpCheckIntervalMs ?? 5_000));
      for (const t of timers) t.unref();
      await chosen;
      await waitAtMost(ready, opts.readyWaitMs ?? 5_000);
    },
    async stop() {
      stopped = true;
      settleReady(false);
      for (const t of timers.splice(0)) clearInterval(t);
      for (const off of unsubscribe.splice(0)) off();
      await backend?.stop();
      await starting;
      await restarting;
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
    get nodeIp() {
      return nodeIp;
    },
    refreshNodeIp,
  };
  return module;
}
