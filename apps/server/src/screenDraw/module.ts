import {
  FEATURE_SCREEN_DRAW,
  PERMISSIONS,
  ProtocolError,
  SCREEN_DRAW_LIMITS,
  has,
  screenDrawAllowSchema,
  screenDrawSchema,
  type ScreenDrawAllowEvent,
  type ScreenDrawEvent,
  type ScreenDrawShare,
  type ScreenDrawWelcome,
} from '@ghostlink/shared';
import type { ModuleContext, ServerModule, SessionInfo } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { NO_CHANNELS, textModuleOf, voiceAccessOf, type VoiceAccess } from '../voice/access.js';
import type { VoiceModule } from '../voice/module.js';

export const SCREEN_DRAW_MODULE = 'screenDraw';

/** What the pencil reads from voice: who LiveKit sees in which room, and who shares a screen there. */
export interface DrawVoiceView {
  channelOf(userId: string): string | null;
  presentIn(channelId: string): string[];
  isSharing(channelId: string, userId: string): boolean;
}

export interface ScreenDrawModuleOptions {
  /** How often "Permitir desenhos" of shares that ended goes back to on (default 1 s). */
  sweepIntervalMs?: number;
  /** Test seam: the voice view (default: the `voice` module's registry). */
  voice?(ctx: ModuleContext): DrawVoiceView | null;
}

/** The `screenDraw` module plus what tests may look at. */
export interface ScreenDrawModule extends ServerModule {
  readonly name: typeof SCREEN_DRAW_MODULE;
  /** The shares where drawing is off now. */
  disallowed(): ScreenDrawShare[];
  /** Turns drawing back on for shares that ended (runs on a timer too). */
  sweep(): void;
}

function voiceViewOf(ctx: ModuleContext): DrawVoiceView | null {
  let voice: VoiceModule;
  try {
    voice = ctx.getModule<VoiceModule>('voice');
  } catch {
    return null;
  }
  const registry = voice.registry;
  return {
    channelOf: (userId) => registry.channelOf(userId),
    presentIn: (channelId) => registry.presentIn(channelId),
    isSharing: (channelId, userId) => registry.state(channelId).participants.some((p) => p.userId === userId && p.screen),
  };
}

const shareKey = (channelId: string, sharerId: string) => `${channelId}:${sharerId}`;

/**
 * The pencil on shared screens (spec 2026-10-01-lapis-na-tela-design.md §3): relays stroke
 * batches to the others in the voice channel and keeps the sharer's "Permitir desenhos".
 * Stores nothing and never logs a payload. Voice owns who is in which room and who shares.
 */
export function createScreenDrawModule(opts: ScreenDrawModuleOptions = {}): ScreenDrawModule {
  let ctx!: ModuleContext;
  let voice: DrawVoiceView | null = null;
  let drawLimiter!: SlidingWindowLimiter;
  let allowLimiter!: SlidingWindowLimiter;
  let timer: NodeJS.Timeout | null = null;
  /** shareKey → the share where the sharer turned drawing off. */
  const off = new Map<string, ScreenDrawShare>();

  const access = (): VoiceAccess => voiceAccessOf(textModuleOf(ctx)) ?? NO_CHANNELS;
  const canSee = (userId: string, channelId: string): boolean => has(access().permissions(userId, channelId), PERMISSIONS.VIEW_CHANNEL);

  /** `screen.drawAllow` goes to everyone who can see the channel, decided per recipient now (spec §5.3). */
  const announce = (d: ScreenDrawAllowEvent): void => {
    ctx.sessions.broadcast({ t: 'screen.drawAllow', d }, (s) => canSee(s.userId, d.channelId));
  };

  /** spec §3: "Permitir desenhos" is on again for every new share, so a share that ended forgets it. */
  const sweep = (): void => {
    drawLimiter?.sweep();
    allowLimiter?.sweep();
    for (const [key, share] of off) {
      if (voice?.isSharing(share.channelId, share.sharerId)) continue;
      off.delete(key);
      announce({ ...share, allow: true });
    }
  };

  /** The caller is in that voice channel now (LiveKit sees them there) and can still see it. */
  const inChannel = (userId: string, channelId: string): boolean => {
    // A channel the user cannot see answers like one that does not exist (spec §5.3).
    if (!canSee(userId, channelId)) throw new ProtocolError('NOT_FOUND');
    return voice?.channelOf(userId) === channelId;
  };

  const draw = (rc: { userId: string }, payload: unknown): Record<string, never> => {
    const p = screenDrawSchema.parse(payload);
    // Above the limit the batch is dropped without an error (spec §3).
    if (!drawLimiter.hit(rc.userId)) return {};
    if (!inChannel(rc.userId, p.channelId)) throw new ProtocolError('FORBIDDEN');
    if (!voice?.isSharing(p.channelId, p.sharerId)) throw new ProtocolError('NOT_FOUND');
    if (off.has(shareKey(p.channelId, p.sharerId))) throw new ProtocolError('FORBIDDEN');
    const d: ScreenDrawEvent = { channelId: p.channelId, sharerId: p.sharerId, userId: rc.userId, strokeId: p.strokeId, points: p.points, end: p.end };
    const present = new Set(voice.presentIn(p.channelId));
    // The others in that voice channel, never the one who drew (their strokes show at once).
    ctx.sessions.broadcast({ t: 'screen.draw', d }, (s) => s.userId !== rc.userId && present.has(s.userId) && canSee(s.userId, p.channelId));
    return {};
  };

  const drawAllow = (rc: { userId: string }, payload: unknown): Record<string, never> => {
    const p = screenDrawAllowSchema.parse(payload);
    if (!allowLimiter.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
    // Only the one sharing there.
    if (!inChannel(rc.userId, p.channelId) || !voice?.isSharing(p.channelId, rc.userId)) throw new ProtocolError('FORBIDDEN');
    const key = shareKey(p.channelId, rc.userId);
    if (p.allow === !off.has(key)) return {};
    if (p.allow) off.delete(key);
    else off.set(key, { channelId: p.channelId, sharerId: rc.userId });
    announce({ channelId: p.channelId, sharerId: rc.userId, allow: p.allow });
    return {};
  };

  const module: ScreenDrawModule = {
    name: SCREEN_DRAW_MODULE,
    get features(): readonly string[] {
      return voice ? [FEATURE_SCREEN_DRAW] : [];
    },
    handlers: {
      'screen.draw': draw,
      'screen.drawAllow': drawAllow,
    },
    init(c) {
      ctx = c;
      voice = opts.voice ? opts.voice(c) : voiceViewOf(c);
      drawLimiter = new SlidingWindowLimiter(SCREEN_DRAW_LIMITS.batchesPerSecond, 1_000, c.now);
      allowLimiter = new SlidingWindowLimiter(SCREEN_DRAW_LIMITS.allowPerWindow, SCREEN_DRAW_LIMITS.allowWindowMs, c.now);
    },
    start() {
      timer = setInterval(sweep, opts.sweepIntervalMs ?? 1_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      off.clear();
    },
    welcome(session: SessionInfo): { screenDraw: ScreenDrawWelcome } {
      const disallowed = [...off.values()].filter(
        (share) => voice?.isSharing(share.channelId, share.sharerId) && canSee(session.userId, share.channelId),
      );
      return { screenDraw: { disallowed } };
    },
    disallowed: () => [...off.values()],
    sweep,
  };
  return module;
}
