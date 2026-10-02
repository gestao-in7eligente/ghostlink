import { join } from 'node:path';
import { FEATURE_GHOST_DJ, GHOST_DJ_LIMITS, GHOST_DJ_SYSTEM_KIND } from '@ghostlink/shared';
import { AVATARS_MODULE_NAME, type AvatarsModule } from '../avatars/index.js';
import { BOTS_MODULE_NAME, type BotsModule } from '../bots/index.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import type { VoiceModule } from '../voice/index.js';
import { DJ_AVATAR_PNG_BASE64 } from './avatar.js';
import { DJ_COMMANDS, DJ_DESCRIPTION, DJ_NAME, say } from './commands.js';
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
  let timer: NodeJS.Timeout | null = null;
  let rtcLoaded = false;
  let stopped = false;

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

  const createOutput = async (): Promise<AudioOutput> => {
    if (opts.createOutput) return opts.createOutput();
    const { createLivekitOutput } = await import('./livekitOutput.js');
    rtcLoaded = true;
    return createLivekitOutput();
  };

  return {
    name: GHOST_DJ_MODULE_NAME,

    get features(): readonly string[] {
      return playable() && voice!.available ? [FEATURE_GHOST_DJ] : [];
    },

    get botId() {
      return botId;
    },

    get dj() {
      return dj;
    },

    init(c) {
      voice = voiceModuleOf(c);
      ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : findFfmpeg();
      const text = c.getModule<TextModule>(TEXT_MODULE_NAME).bots;
      const bots = c.getModule<BotsModule>(BOTS_MODULE_NAME);
      const dir = join(c.dataDir, GHOST_DJ_DIR);
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
      const bot = bots.ensureSystemBot({
        kind: GHOST_DJ_SYSTEM_KIND,
        name: DJ_NAME,
        description: DJ_DESCRIPTION,
        commands: DJ_COMMANDS,
        onInteraction: (e) => dj?.handle(e),
      });
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
      });
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
