import { join } from 'node:path';
import {
  FEATURE_GHOST_DJ,
  FEATURE_GHOST_DJ_PANEL,
  GHOST_DJ_EQ_PRESETS,
  GHOST_DJ_LIMITS,
  GHOST_DJ_SYSTEM_KIND,
  PERMISSIONS,
  ProtocolError,
  ghostDjControlSchema,
  ghostDjCookiesClearSchema,
  ghostDjCookiesSetSchema,
  ghostDjEqSchema,
  ghostDjEqStoredSchema,
  ghostDjStateRequestSchema,
  ghostDjVolumeSchema,
  has,
  type GhostDjEq,
  type GhostDjState,
} from '@ghostlink/shared';
import { AVATARS_MODULE_NAME, type AvatarsModule } from '../avatars/index.js';
import { BOTS_MODULE_NAME, type BotsModule, type SystemBot } from '../bots/index.js';
import type { Db } from '../db/database.js';
import { enterpriseOf } from '../enterprise/index.js';
import type { ModuleContext, RequestContext, RequestHandler, ServerModule } from '../modules.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import type { VoiceModule } from '../voice/index.js';
import { DJ_AVATAR_PNG_BASE64 } from './avatar.js';
import { DJ_COMMANDS, DJ_DESCRIPTION, DJ_NAME, say } from './commands.js';
import { clearCookies, cookiesView, saveCookies } from './cookies.js';
import { GhostDj, type DjTrack, type DjVoice } from './dj.js';
import { findFfmpeg, openYoutubePcm, type PcmSource } from './ffmpeg.js';
import type { AudioOutput } from './output.js';
import type { PlayTarget } from './youtube.js';
import { COOKIES_FILE, YtDlpBinary, YtDlpRunner, type ResolveResult, type SpawnFn } from './ytdlp.js';

export { GhostDj, gainOf, type DjTrack } from './dj.js';
export { FRAME_BYTES, FRAME_SAMPLES, type PcmSource } from './ffmpeg.js';
export type { AudioOutput } from './output.js';
export type { ResolveResult, ResolvedTrack, TrackError } from './ytdlp.js';

export const GHOST_DJ_MODULE_NAME = 'ghostDj';
/** A burst of changes (a slider dragged) sends one `dj.state`. */
const STATE_DELAY_MS = 50;
/** `<data>/ghost-dj/`: yt-dlp, its manifest and cache, and the owner's cookies.txt. */
export const GHOST_DJ_DIR = 'ghost-dj';

export interface GhostDjModuleOptions {
  /** The ffmpeg command; null: none. Default: `ffmpeg`, when it runs. */
  ffmpeg?: string | null;
  /** yt-dlp's download (tests: a local server); false: never download (tests with `resolve`). */
  ytdlp?: { releases?: string; fetch?: typeof fetch; asset?: string | null; spawn?: SpawnFn } | false;
  /** Test seam: what yt-dlp would answer. */
  resolve?: (target: PlayTarget) => Promise<ResolveResult>;
  /** Test seam: a track's PCM. */
  openSource?: (track: DjTrack) => PcmSource;
  /** Test seam: where the sound goes (default: a LiveKit participant, @livekit/rtc-node). */
  createOutput?: () => Promise<AudioOutput>;
  idleLeaveMs?: number;
  aloneLeaveMs?: number;
  panelDelayMs?: number;
  /** How often the idle and alone rules are checked. Default 5 s. */
  tickMs?: number;
  /** How long a burst of changes waits before one `dj.state` goes out. Default 50 ms. */
  stateDelayMs?: number;
  /**
   * End rtc-node's native side when the server stops (its threads would keep the process
   * alive). Default true; tests that run several servers in one process pass false.
   */
  disposeOnStop?: boolean;
}

export interface GhostDjModule extends ServerModule {
  readonly name: typeof GHOST_DJ_MODULE_NAME;
  /** The DJ's member id (after init). */
  readonly botId: string | null;
  /** The engine (after init), for tests. */
  readonly dj: GhostDj | null;
  /** Runs the idle and alone checks now (they also run on a timer). */
  tick(): void;
  /** One line for the CLI: whether the DJ can play, or what it lacks. */
  status(): string;
}

function voiceModuleOf(ctx: ModuleContext): VoiceModule | null {
  try {
    return ctx.getModule<VoiceModule>('voice');
  } catch {
    return null;
  }
}

/** The server's equalizer as saved; flat ("Padrão") until someone changes it. */
function loadEq(db: Db): GhostDjEq {
  const row = db.get<{ eq_preset: string; eq_gains: string }>('SELECT eq_preset, eq_gains FROM ghost_dj_settings WHERE id = 1');
  if (row) {
    try {
      return ghostDjEqStoredSchema.parse({ preset: row.eq_preset, gains: JSON.parse(row.eq_gains) });
    } catch {
      // unreadable: back to flat
    }
  }
  return { preset: 'default', gains: [...GHOST_DJ_EQ_PRESETS.default] };
}

function saveEq(db: Db, eq: GhostDjEq): void {
  db.run(
    'INSERT INTO ghost_dj_settings (id, eq_preset, eq_gains) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET eq_preset = excluded.eq_preset, eq_gains = excluded.eq_gains',
    eq.preset,
    JSON.stringify(eq.gains),
  );
}

/** While the server is Enterprise the DJ does not exist: its requests answer NOT_FOUND (its data stays). */
function unlessHidden(isHidden: () => boolean, handlers: Record<string, RequestHandler>): Record<string, RequestHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([type, handler]): [string, RequestHandler] => [
      type,
      (rc, payload) => {
        if (isHidden()) throw new ProtocolError('NOT_FOUND');
        return handler(rc, payload);
      },
    ]),
  );
}

function avatarsModuleOf(ctx: ModuleContext): AvatarsModule | null {
  try {
    return ctx.getModule<AvatarsModule>(AVATARS_MODULE_NAME);
  } catch {
    return null;
  }
}

/**
 * Ghost DJ (spec 2026-10-02-ghost-dj-design.md): the music bot every server has. A system bot
 * the server creates (bots module), slash commands answered here, YouTube through yt-dlp,
 * ffmpeg's PCM published into the voice channel's LiveKit room. The `ghostDj` flag is on while
 * ffmpeg exists and LiveKit runs. Register after text, voice, avatars and bots.
 */
export function createGhostDjModule(opts: GhostDjModuleOptions = {}): GhostDjModule {
  let voice: VoiceModule | null = null;
  let ffmpeg: string | null = null;
  let binary: YtDlpBinary | null = null;
  let runner: YtDlpRunner | null = null;
  let dj: GhostDj | null = null;
  let botId: string | null = null;
  let hidden = false;
  let systemBot: SystemBot | null = null;
  let timer: NodeJS.Timeout | null = null;
  let rtcLoaded = false;
  let stopped = false;
  let ctx: ModuleContext | null = null;
  let stateTimer: NodeJS.Timeout | null = null;
  /** `<data>/ghost-dj` (after init). */
  let djDir = '';

  const playable = (): boolean => ffmpeg !== null && voice !== null;

  const unavailable = (): string | null => {
    if (!playable()) return say.unavailable;
    if (!voice!.available) return say.voiceDown;
    if (!opts.resolve && !runner?.ready) {
      binary?.retrySoon();
      return say.preparing;
    }
    return null;
  };

  const textModule = (): TextModule => ctx!.getModule<TextModule>(TEXT_MODULE_NAME);
  const isOwner = (userId: string): boolean => textModule().voiceAccess.isOwner(userId);

  /**
   * The state as `userId` may see it: without the voice channel and its tracks when they cannot
   * see that channel (as if the DJ were in none; the equalizer is the server's). Only the owner
   * gets the cookies line (when they were sent, never their content).
   */
  const stateFor = (userId: string, full: GhostDjState): GhostDjState => {
    const seen =
      full.channelId === null || has(textModule().voiceAccess.permissions(userId, full.channelId), PERMISSIONS.VIEW_CHANNEL)
        ? full
        : { ...full, channelId: null, current: null, positionSec: 0, paused: false, volume: GHOST_DJ_LIMITS.defaultVolume, loop: 'off' as const, next: [], queueLength: 0 };
    return isOwner(userId) ? { ...seen, cookies: cookiesView(djDir) } : seen;
  };

  /** The cookies requests are the owner's alone. */
  const requireOwner = (rc: RequestContext): void => {
    if (!isOwner(rc.userId)) throw new ProtocolError('FORBIDDEN');
  };

  /** `dj.state` to every session (each as they may see it), once per burst of changes. */
  const announce = (): void => {
    if (stateTimer || stopped || !ctx) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      if (!dj || !ctx || stopped) return;
      const full = dj.view();
      for (const session of ctx.sessions.list()) ctx.sessions.send(session.sessionId, { t: 'dj.state', d: stateFor(session.userId, full) });
    }, opts.stateDelayMs ?? STATE_DELAY_MS);
    stateTimer.unref();
  };

  const engine = (): GhostDj => {
    if (!dj) throw new Error('the Ghost DJ is not initialized');
    return dj;
  };

  /** A panel request: the new state as the caller sees it. */
  const answer = (rc: RequestContext): GhostDjState => stateFor(rc.userId, engine().view());

  const createOutput = async (): Promise<AudioOutput> => {
    if (opts.createOutput) return opts.createOutput();
    const { createLivekitOutput } = await import('./livekitOutput.js');
    rtcLoaded = true;
    return createLivekitOutput();
  };

  /** Parking the DJ cleared its photo (the avatars module clears a leaver's): put the default one back. */
  const restorePhoto = (): void => {
    if (!ctx || !botId) return;
    const row = ctx.db.get<{ avatar_file_id: string | null }>('SELECT avatar_file_id FROM users WHERE id = ? AND removed_at IS NULL', botId);
    if (!row || row.avatar_file_id !== null) return;
    try {
      avatarsModuleOf(ctx)?.setServerPhoto(botId, Buffer.from(DJ_AVATAR_PNG_BASE64, 'base64'), 'image/png');
    } catch (e) {
      ctx.logger.warn('Ghost DJ: could not set its photo', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Enterprise: stop, leave the call, then leave the member list (spec 2026-10-02-enterprise §1). */
  const setEnterprise = async (on: boolean): Promise<void> => {
    if (on === hidden) return;
    hidden = on;
    if (on) {
      await dj?.leave().catch((e: unknown) => ctx?.logger.warn('Ghost DJ: could not leave', { error: e instanceof Error ? e.message : String(e) }));
      if (hidden) systemBot?.setHidden(true);
    } else {
      dj?.reopen();
      systemBot?.setHidden(false);
      restorePhoto();
    }
  };

  return {
    name: GHOST_DJ_MODULE_NAME,

    get features(): readonly string[] {
      if (hidden) return [];
      return playable() && voice!.available ? [FEATURE_GHOST_DJ, FEATURE_GHOST_DJ_PANEL] : [FEATURE_GHOST_DJ_PANEL];
    },

    handlers: unlessHidden(() => hidden, {
      'dj.state': (rc, payload) => {
        ghostDjStateRequestSchema.parse(payload);
        return answer(rc);
      },
      'dj.eq': (rc, payload) => {
        engine().setEq(rc.userId, ghostDjEqSchema.parse(payload));
        return answer(rc);
      },
      'dj.volume': (rc, payload) => {
        engine().setVolume(rc.userId, ghostDjVolumeSchema.parse(payload).volume);
        return answer(rc);
      },
      'dj.control': async (rc, payload) => {
        await engine().control(rc.userId, ghostDjControlSchema.parse(payload).action);
        return answer(rc);
      },
      'dj.cookies.set': (rc, payload) => {
        requireOwner(rc);
        saveCookies(djDir, ghostDjCookiesSetSchema.parse(payload).content);
        rc.logger.info('Ghost DJ: the owner sent YouTube cookies');
        announce();
        return answer(rc);
      },
      'dj.cookies.clear': (rc, payload) => {
        requireOwner(rc);
        ghostDjCookiesClearSchema.parse(payload);
        clearCookies(djDir);
        rc.logger.info('Ghost DJ: the owner removed the YouTube cookies');
        announce();
        return answer(rc);
      },
    }),

    get botId() {
      return botId;
    },

    get dj() {
      return dj;
    },

    init(c) {
      ctx = c;
      voice = voiceModuleOf(c);
      ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : findFfmpeg();
      const text = c.getModule<TextModule>(TEXT_MODULE_NAME).bots;
      const bots = c.getModule<BotsModule>(BOTS_MODULE_NAME);
      const dir = join(c.dataDir, GHOST_DJ_DIR);
      djDir = dir;
      if (opts.ytdlp !== false) {
        binary = new YtDlpBinary({ dir, logger: c.logger, releases: opts.ytdlp?.releases, fetch: opts.ytdlp?.fetch, asset: opts.ytdlp?.asset });
        runner = new YtDlpRunner({ binary: () => binary!.path, dir, spawn: opts.ytdlp?.spawn });
      }
      const djVoice: DjVoice = {
        get available() {
          return voice?.available === true;
        },
        joinLocal: (userId, channelId) => voice!.joinLocal(userId, channelId),
        leaveLocal: (userId) => voice?.leaveLocal(userId) ?? Promise.resolve(),
        channelOf: (userId) => voice?.registry.channelOf(userId) ?? voice?.registry.assignedChannel(userId) ?? null,
        presentIn: (channelId) => voice?.registry.presentIn(channelId) ?? [],
        onStateChange: (listener) => voice?.onStateChange(listener) ?? (() => {}),
      };
      const enterprise = enterpriseOf(c);
      hidden = enterprise?.edition === 'enterprise';
      const bot = bots.ensureSystemBot({
        kind: GHOST_DJ_SYSTEM_KIND,
        name: DJ_NAME,
        description: DJ_DESCRIPTION,
        commands: DJ_COMMANDS,
        onInteraction: (e) => {
          if (!hidden) dj?.handle(e);
        },
        hidden,
      });
      systemBot = bot;
      botId = bot.botId;
      if (bot.fresh) {
        try {
          avatarsModuleOf(c)?.setServerPhoto(bot.botId, Buffer.from(DJ_AVATAR_PNG_BASE64, 'base64'), 'image/png');
        } catch (e) {
          c.logger.warn('Ghost DJ: could not set its photo', { error: e instanceof Error ? e.message : String(e) });
        }
      }
      dj = new GhostDj({
        bot,
        voice: djVoice,
        channelName: (channelId) => text.channelName(channelId),
        now: c.now,
        logger: c.logger,
        unavailable,
        resolve: opts.resolve ?? ((target) => runner!.resolve(target)),
        hasCookies: () => runner?.hasCookies ?? false,
        openSource:
          opts.openSource ?? ((track) => openYoutubePcm({ runner: runner!, ffmpeg: ffmpeg!, videoUrl: track.url })),
        createOutput,
        idleLeaveMs: opts.idleLeaveMs ?? GHOST_DJ_LIMITS.idleLeaveMs,
        aloneLeaveMs: opts.aloneLeaveMs ?? GHOST_DJ_LIMITS.aloneLeaveMs,
        panelDelayMs: opts.panelDelayMs ?? 1_000,
        eq: loadEq(c.db),
        saveEq: (eq) => saveEq(c.db, eq),
        onState: announce,
      });
      enterprise?.onChange((edition) => void setEnterprise(edition === 'enterprise'));
    },

    start() {
      // yt-dlp only where the DJ can play (ffmpeg, and LiveKit runs): the installed one at once,
      // a download or an update in the background a little later.
      if (playable() && binary) {
        const b = binary;
        void b.load();
        void voice!.whenReady().then((ok) => {
          if (ok && !stopped) b.start();
        });
      }
      timer = setInterval(() => dj?.tick(), opts.tickMs ?? 5_000);
      timer.unref();
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (stateTimer) clearTimeout(stateTimer);
      stateTimer = null;
      binary?.stop();
      await dj?.shutdown();
      if (rtcLoaded && opts.disposeOnStop !== false) {
        const { disposeLivekit } = await import('./livekitOutput.js');
        await disposeLivekit().catch(() => undefined);
      }
    },

    tick() {
      dj?.tick();
    },

    status() {
      if (ffmpeg === null) return 'off: ffmpeg was not found (install it: sudo apt install ffmpeg)';
      if (voice === null || !voice.available) return 'off: voice (LiveKit) is not running';
      const cookies = runner?.hasCookies ? `, with ${GHOST_DJ_DIR}/${COOKIES_FILE}` : '';
      return `on (yt-dlp ${binary?.version ?? 'is being downloaded'}${cookies})`;
    },
  };
}
