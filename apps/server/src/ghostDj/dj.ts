import {
  GHOST_DJ_EQ_PRESETS,
  GHOST_DJ_LIMITS,
  GHOST_DJ_PANEL_NEXT,
  ProtocolError,
  type GhostDjControlAction,
  type GhostDjEq,
  type GhostDjEqPayload,
  type GhostDjState,
  type GhostDjTrackView,
  type InteractionCreateEvent,
  type InteractionOption,
} from '@ghostlink/shared';
import type { SystemBot } from '../bots/index.js';
import type { Logger } from '../logger.js';
import { LOOP_CHOICES, loopLabel, say, trackErrorText, type LoopMode } from './commands.js';
import { DjMixer } from './equalizer.js';
import { FRAME_BYTES, FRAME_SAMPLES, type PcmSource } from './ffmpeg.js';
import type { AudioOutput } from './output.js';
import { chatText, formatDuration, parsePlayQuery, type PlayTarget } from './youtube.js';
import type { ResolveResult, TrackError } from './ytdlp.js';

/** One track in the DJ's queue. */
export interface DjTrack {
  id: string;
  title: string;
  url: string;
  durationSec: number | null;
  requestedBy: string;
  requesterName: string;
}

/** What the DJ needs from voice (voice/module.ts). */
export interface DjVoice {
  readonly available: boolean;
  joinLocal(userId: string, channelId: string): Promise<{ url: string; token: string; icePort: number | null }>;
  leaveLocal(userId: string): Promise<void>;
  /** The voice channel the user is in (or joining), or null. */
  channelOf(userId: string): string | null;
  /** Who LiveKit sees in the channel. */
  presentIn(channelId: string): string[];
  onStateChange(listener: (channelIds: string[]) => void): () => void;
}

export interface DjDeps {
  bot: SystemBot;
  voice: DjVoice;
  /** A channel's name for messages; null when it is gone. */
  channelName(channelId: string): string | null;
  now(): number;
  logger: Logger;
  /** Why /play cannot work now (a message), or null. */
  unavailable(): string | null;
  resolve(target: PlayTarget): Promise<ResolveResult>;
  /** Whether `ghost-dj/cookies.txt` exists (for the "blocked" message). */
  hasCookies(): boolean;
  openSource(track: DjTrack): PcmSource;
  createOutput(): Promise<AudioOutput>;
  idleLeaveMs: number;
  aloneLeaveMs: number;
  /** A burst of changes edits the panel once. */
  panelDelayMs: number;
  /** The equalizer as saved for this server (it applies to every session). */
  eq: GhostDjEq;
  /** Saves a new equalizer (it survives restarts). */
  saveEq(eq: GhostDjEq): void;
  /** What the panels show changed (`dj.state` goes out). */
  onState(): void;
}

type EndReason = 'stop' | 'idle' | 'alone' | 'disconnected' | 'shutdown';

interface Session {
  voiceChannelId: string;
  textChannelId: string;
  output: AudioOutput;
  panelId: number | null;
  panelTimer: NodeJS.Timeout | null;
  queue: DjTrack[];
  current: DjTrack | null;
  /** 20 ms frames of `current` played so far. */
  frames: number;
  paused: boolean;
  volume: number;
  loop: LoopMode;
  source: PcmSource | null;
  /** Wakes the playback loop out of a pause (or a skip/stop during one). */
  wake: (() => void) | null;
  running: boolean;
  /** Since when nothing plays (nothing queued, or paused); null while it plays. */
  idleSince: number | null;
  /** Since when nobody else is in its channel; null while someone is. */
  aloneSince: number | null;
  /** A track that could not be played, shown on the panel while the next one plays. */
  notice: string | null;
  ended: boolean;
  /** The equalizer and the volume, with their filters' memory. */
  mixer: DjMixer;
}

type Outcome = { kind: 'ended' } | { kind: 'skipped' } | { kind: 'stopped' } | { kind: 'failed'; error: TrackError };

const MAX_FRAMES = GHOST_DJ_LIMITS.maxTrackSeconds * (48_000 / FRAME_SAMPLES);
/** Lines of /queue. */
const QUEUE_LINES = 10;

function stringOption(options: readonly InteractionOption[], name: string): string | null {
  const v = options.find((o) => o.name === name)?.value;
  return typeof v === 'string' ? v : null;
}

function numberOption(options: readonly InteractionOption[], name: string): number | null {
  const v = options.find((o) => o.name === name)?.value;
  return typeof v === 'number' ? v : null;
}

/** /volume 0–100 → gain: quadratic, so the steps sound even; 100 is the original level. */
export function gainOf(volume: number): number {
  return (Math.max(0, Math.min(100, volume)) / 100) ** 2;
}

function trackView(t: DjTrack): GhostDjTrackView {
  return { title: t.title, url: t.url, durationSec: t.durationSec, requestedBy: t.requestedBy, requesterName: t.requesterName };
}

function trackLine(t: DjTrack): string {
  const length = formatDuration(t.durationSec);
  return `**${chatText(t.title, 100)}**${length ? ` (${length})` : ''} — ${chatText(t.requesterName, 40)}`;
}

/**
 * The Ghost DJ of one server (spec §1): one voice channel at a time, a queue, the "Tocando
 * agora" panel and the control rules. Its commands arrive through the bots module
 * (SystemBot); its sound goes to an AudioOutput.
 */
export class GhostDj {
  readonly #d: DjDeps;
  #eq: GhostDjEq;
  #session: Session | null = null;
  #opening: Promise<Session> | null = null;
  /** Set by `leave()` while the server is Enterprise: no new call is joined. */
  #closed = false;
  readonly #offState: () => void;

  constructor(deps: DjDeps) {
    this.#d = deps;
    this.#eq = { preset: deps.eq.preset, gains: [...deps.eq.gains] };
    this.#offState = deps.voice.onStateChange((ids) => {
      const s = this.#session;
      if (s && ids.includes(s.voiceChannelId)) this.#checkAlone(s);
    });
  }

  /** The voice channel it plays in, or null. */
  get channelId(): string | null {
    return this.#session?.voiceChannelId ?? null;
  }

  /** For tests and the panel: what plays and what waits. */
  get state(): { current: DjTrack | null; queue: DjTrack[]; paused: boolean; volume: number; loop: LoopMode; panelId: number | null } | null {
    const s = this.#session;
    return s ? { current: s.current, queue: [...s.queue], paused: s.paused, volume: s.volume, loop: s.loop, panelId: s.panelId } : null;
  }

  /** What the panels show (`dj.state`), as everyone who can see its voice channel sees it. */
  view(): GhostDjState {
    const s = this.#session;
    return {
      channelId: s?.voiceChannelId ?? null,
      current: s?.current ? trackView(s.current) : null,
      positionSec: s?.current ? (s.frames * FRAME_SAMPLES) / 48_000 : 0,
      paused: s?.paused ?? false,
      volume: s?.volume ?? GHOST_DJ_LIMITS.defaultVolume,
      loop: s?.loop ?? 'off',
      next: (s?.queue ?? []).slice(0, GHOST_DJ_PANEL_NEXT).map(trackView),
      queueLength: s?.queue.length ?? 0,
      eq: { preset: this.#eq.preset, gains: [...this.#eq.gains] },
    };
  }

  // ---- the panel (spec 2026-10-02-ghost-dj-som-e-equalizador §2): the slash commands' rules ----

  /** The session `userId` may control: they are in its voice channel. FORBIDDEN otherwise. */
  #controlledBy(userId: string): Session {
    const s = this.#session;
    if (!s || s.ended || this.#d.voice.channelOf(userId) !== s.voiceChannelId) throw new ProtocolError('FORBIDDEN');
    return s;
  }

  /** A preset, or the five gains by hand ("Personalizado"): saved for the server and heard at once. */
  setEq(userId: string, eq: GhostDjEqPayload): void {
    this.#controlledBy(userId);
    this.#eq = 'preset' in eq ? { preset: eq.preset, gains: [...GHOST_DJ_EQ_PRESETS[eq.preset]] } : { preset: 'custom', gains: [...eq.gains] };
    this.#d.saveEq(this.#eq);
    this.#d.onState();
  }

  setVolume(userId: string, volume: number): void {
    const s = this.#controlledBy(userId);
    s.volume = volume;
    this.#panel(s);
  }

  /** Pause, resume, skip (NOT_FOUND with nothing playing) or stop (it leaves the channel). */
  async control(userId: string, action: GhostDjControlAction): Promise<void> {
    const s = this.#controlledBy(userId);
    if (action === 'stop') return this.#end(s, 'stop');
    if (!s.current || (action === 'skip' && !s.source)) throw new ProtocolError('NOT_FOUND');
    if (action === 'skip') this.#cut(s);
    else this.#setPaused(s, action === 'pause');
  }

  /** An interaction for the DJ (SystemBotSpec.onInteraction). Never throws. */
  handle(e: InteractionCreateEvent): void {
    void this.#dispatch(e).catch((err: unknown) => {
      this.#d.logger.warn('Ghost DJ: a command failed', { command: e.command, error: err instanceof Error ? err.message : String(err) });
      this.#answer(e, say.failed, true);
    });
  }

  /** Every few seconds: leaves after the idle time, or once alone for a while. */
  tick(): void {
    const s = this.#session;
    if (!s || s.ended) return;
    this.#checkAlone(s);
    const now = this.#d.now();
    if (s.aloneSince !== null && now - s.aloneSince >= this.#d.aloneLeaveMs) void this.#end(s, 'alone');
    else if (s.idleSince !== null && now - s.idleSince >= this.#d.idleLeaveMs) void this.#end(s, 'idle');
  }

  async shutdown(): Promise<void> {
    this.#offState();
    await this.#opening?.catch(() => undefined);
    if (this.#session) await this.#end(this.#session, 'shutdown');
  }

  /** Stops and leaves its voice channel, as /stop does (the server became Enterprise). */
  async leave(): Promise<void> {
    this.#closed = true;
    await this.#opening?.catch(() => undefined);
    if (this.#session) await this.#end(this.#session, 'stop');
  }

  // ---- commands ----

  async #dispatch(e: InteractionCreateEvent): Promise<void> {
    switch (e.command) {
      case 'play':
        return this.#play(e);
      case 'pause':
      case 'resume':
        return this.#pause(e, e.command === 'pause');
      case 'skip':
        return this.#skip(e);
      case 'stop':
        return this.#stop(e);
      case 'queue':
        return this.#answer(e, this.#queueText(), true);
      case 'nowplaying':
        return this.#nowPlaying(e);
      case 'volume':
        return this.#volume(e);
      case 'loop':
        return this.#loopMode(e);
      default:
        return this.#answer(e, say.failed, true);
    }
  }

  /** A first answer; a failure (expired, rate limited) is only logged. */
  #answer(e: InteractionCreateEvent, content: string, ephemeral: boolean): void {
    try {
      this.#d.bot.respond({ id: e.id, type: 'reply', content, ephemeral });
    } catch (err) {
      this.#d.logger.warn('Ghost DJ: could not answer a command', { command: e.command, error: err instanceof Error ? err.message : String(err) });
    }
  }

  #edit(e: InteractionCreateEvent, content: string): void {
    try {
      this.#d.bot.edit(e.id, content);
    } catch (err) {
      this.#d.logger.warn('Ghost DJ: could not answer a command', { command: e.command, error: err instanceof Error ? err.message : String(err) });
    }
  }

  #voiceName(channelId: string): string {
    return chatText(this.#d.channelName(channelId) ?? 'canal de voz', 100);
  }

  async #play(e: InteractionCreateEvent): Promise<void> {
    const why = this.#d.unavailable();
    if (why) return this.#answer(e, why, true);
    const target = parsePlayQuery(stringOption(e.options, 'busca') ?? '');
    if (!target) return this.#answer(e, say.invalidQuery, true);
    const voiceId = this.#d.voice.channelOf(e.user.userId);
    if (!voiceId) return this.#answer(e, say.notInVoice, true);
    const busy = this.#session ?? null;
    if (busy && busy.voiceChannelId !== voiceId) return this.#answer(e, say.busy(this.#voiceName(busy.voiceChannelId)), true);
    if (busy && busy.queue.length >= GHOST_DJ_LIMITS.maxQueue) return this.#answer(e, say.queueFull, true);

    // Only the person who asked sees the search and its outcome; the panel shows the rest.
    this.#d.bot.respond({ id: e.id, type: 'defer', ephemeral: true });
    const result = await this.#d.resolve(target);
    if (!result.ok) {
      return this.#edit(e, trackErrorText(result.error, { hasCookies: result.blockedWithCookies ?? this.#d.hasCookies(), query: target.kind === 'search' ? chatText(target.query, 100) : undefined }));
    }
    let s = this.#session;
    if (s && s.voiceChannelId !== voiceId) return this.#edit(e, say.busy(this.#voiceName(s.voiceChannelId)));
    if (!s) {
      try {
        s = await this.#open(voiceId, e.channelId);
      } catch (err) {
        return this.#edit(e, this.#joinError(err, voiceId));
      }
      if (s.voiceChannelId !== voiceId) return this.#edit(e, say.busy(this.#voiceName(s.voiceChannelId)));
    }
    if (s.ended) return this.#edit(e, say.joinFailed);
    const room =GHOST_DJ_LIMITS.maxQueue - s.queue.length + (s.current ? 0 : 1);
    if (room <= 0) return this.#edit(e, say.queueFull);
    const tracks: DjTrack[] = result.tracks.slice(0, room).map((t) => ({ ...t, requestedBy: e.user.userId, requesterName: e.user.nickname }));
    const startNow = s.current === null;
    if (startNow) s.current = tracks.shift()!;
    const position = s.queue.length + 1;
    s.queue.push(...tracks);
    this.#panel(s);
    if (startNow) void this.#run(s);

    const first = startNow ? s.current : tracks[0]!;
    const added = result.tracks.slice(0, room).length;
    const left = result.tracks.length - added + result.skipped;
    let text: string;
    if (result.playlistTitle !== null || added > 1) {
      text = `🎶 ${added} músicas${result.playlistTitle ? ` da playlist **${chatText(result.playlistTitle, 100)}**` : ''} na fila.`;
      if (left > 0) text += ` (${left} ficaram de fora: indisponíveis, longas demais ou além do limite da fila.)`;
    } else {
      text = startNow ? `▶️ Tocando agora: ${trackLine(first!)}` : `🎶 Na fila (${position}º): ${trackLine(first!)}`;
    }
    this.#edit(e, text);
  }

  #joinError(err: unknown, voiceId: string): string {
    const code = err instanceof ProtocolError ? err.code : null;
    if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return say.joinForbidden(this.#voiceName(voiceId));
    if (code === 'CHANNEL_FULL') return say.channelFull(this.#voiceName(voiceId));
    this.#d.logger.warn('Ghost DJ: could not join a voice channel', { error: err instanceof Error ? err.message : String(err) });
    return say.joinFailed;
  }

  /** Who may control it: whoever is in its voice channel. Answers the refusal itself. */
  #controlled(e: InteractionCreateEvent): Session | null {
    const s = this.#session;
    if (!s) {
      this.#answer(e, say.notPlaying, true);
      return null;
    }
    if (this.#d.voice.channelOf(e.user.userId) !== s.voiceChannelId) {
      this.#answer(e, say.joinToControl(this.#voiceName(s.voiceChannelId)), true);
      return null;
    }
    return s;
  }

  #pause(e: InteractionCreateEvent, pause: boolean): void {
    const s = this.#controlled(e);
    if (!s) return;
    if (!s.current) return this.#answer(e, say.notPlaying, true);
    if (pause === s.paused) return this.#answer(e, pause ? say.alreadyPaused : say.notPaused, true);
    this.#setPaused(s, pause);
    this.#answer(e, pause ? say.paused(chatText(e.user.nickname, 40)) : say.resumed(chatText(e.user.nickname, 40)), false);
  }

  #setPaused(s: Session, pause: boolean): void {
    if (pause === s.paused) return;
    s.paused = pause;
    if (pause) {
      s.output.clear();
      s.idleSince = this.#d.now();
    } else {
      s.idleSince = null;
      this.#wake(s);
    }
    this.#panel(s);
  }

  #skip(e: InteractionCreateEvent): void {
    const s = this.#controlled(e);
    if (!s) return;
    const current = s.current;
    if (!current || !s.source) return this.#answer(e, say.nothingToSkip, true);
    this.#cut(s);
    this.#answer(e, say.skipped(chatText(e.user.nickname, 40), chatText(current.title, 100)), false);
  }

  async #stop(e: InteractionCreateEvent): Promise<void> {
    const s = this.#controlled(e);
    if (!s) return;
    this.#answer(e, say.stopped(chatText(e.user.nickname, 40)), false);
    await this.#end(s, 'stop');
  }

  #volume(e: InteractionCreateEvent): void {
    const s = this.#controlled(e);
    if (!s) return;
    const level = numberOption(e.options, 'nivel');
    if (level === null || !Number.isInteger(level) || level < 0 || level > 100) return this.#answer(e, say.badVolume, true);
    s.volume = level;
    this.#panel(s);
    this.#answer(e, say.volume(chatText(e.user.nickname, 40), level), false);
  }

  #loopMode(e: InteractionCreateEvent): void {
    const s = this.#controlled(e);
    if (!s) return;
    const choice = stringOption(e.options, 'modo');
    const mode = choice !== null && Object.hasOwn(LOOP_CHOICES, choice) ? LOOP_CHOICES[choice]! : null;
    if (!mode) return this.#answer(e, say.badLoop, true);
    s.loop = mode;
    this.#panel(s);
    this.#answer(e, say.loop(chatText(e.user.nickname, 40), mode), false);
  }

  #nowPlaying(e: InteractionCreateEvent): void {
    const s = this.#session;
    if (!s?.current) return this.#answer(e, say.notPlaying, true);
    const t = s.current;
    const at = formatDuration(s.frames * (FRAME_SAMPLES / 48_000));
    const length = formatDuration(t.durationSec);
    const text = [
      `${s.paused ? '⏸️ Pausado' : '🎶 Tocando agora'} em 🔊 ${this.#voiceName(s.voiceChannelId)}: **${chatText(t.title, 100)}** (${at}${length ? ` / ${length}` : ''})`,
      `Pedido por ${chatText(t.requesterName, 40)} · ${t.url}`,
    ].join('\n');
    this.#answer(e, text, false);
  }

  #queueText(): string {
    const s = this.#session;
    if (!s?.current) return say.notPlaying;
    const lines = [`**Tocando:** ${trackLine(s.current)}${s.paused ? ' (pausado)' : ''}`];
    if (s.queue.length === 0) lines.push('A fila está vazia.');
    else {
      lines.push(`**Fila (${s.queue.length}):**`);
      s.queue.slice(0, QUEUE_LINES).forEach((t, i) => lines.push(`${i + 1}. ${trackLine(t)}`));
      if (s.queue.length > QUEUE_LINES) lines.push(`… e mais ${s.queue.length - QUEUE_LINES}.`);
    }
    lines.push(`Volume ${s.volume} · Repetir: ${loopLabel(s.loop)}`);
    return lines.join('\n');
  }

  // ---- the session ----

  /** Lets the DJ join calls again after `leave()` (the server is normal again). */
  reopen(): void {
    this.#closed = false;
  }

  /** Joins the voice channel (one at a time: a second /play meanwhile waits for this one). */
  #open(voiceChannelId: string, textChannelId: string): Promise<Session> {
    if (this.#session) return Promise.resolve(this.#session);
    if (this.#closed) return Promise.reject(new Error('the Ghost DJ is closed'));
    this.#opening ??= this.#connect(voiceChannelId, textChannelId).finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #connect(voiceChannelId: string, textChannelId: string): Promise<Session> {
    const botId = this.#d.bot.botId;
    const { url, token, icePort } = await this.#d.voice.joinLocal(botId, voiceChannelId);
    let output: AudioOutput | null = null;
    try {
      output = await this.#d.createOutput();
      await output.connect(url, token, icePort);
    } catch (e) {
      await output?.close().catch(() => undefined);
      await this.#d.voice.leaveLocal(botId).catch(() => undefined);
      throw e;
    }
    const s: Session = {
      voiceChannelId,
      textChannelId,
      output,
      panelId: null,
      panelTimer: null,
      queue: [],
      current: null,
      frames: 0,
      paused: false,
      volume: GHOST_DJ_LIMITS.defaultVolume,
      loop: 'off',
      source: null,
      wake: null,
      running: false,
      idleSince: this.#d.now(),
      aloneSince: null,
      notice: null,
      ended: false,
      mixer: new DjMixer(),
    };
    output.onClosed(() => void this.#end(s, 'disconnected'));
    this.#session = s;
    return s;
  }

  async #end(s: Session, reason: EndReason): Promise<void> {
    if (s.ended) return;
    s.ended = true;
    if (this.#session === s) this.#session = null;
    this.#d.onState();
    const voiceName = this.#voiceName(s.voiceChannelId);
    s.queue = [];
    s.current = null;
    this.#cut(s);
    if (s.panelTimer) clearTimeout(s.panelTimer);
    s.panelTimer = null;
    const why: Record<EndReason, string> = {
      stop: `⏹️ O Ghost DJ parou e saiu de 🔊 ${voiceName}.`,
      idle: `💤 O Ghost DJ saiu de 🔊 ${voiceName} depois de ${Math.round(this.#d.idleLeaveMs / 60_000)} minutos sem tocar.`,
      alone: `👋 O Ghost DJ saiu de 🔊 ${voiceName} porque ficou sozinho.`,
      disconnected: `O Ghost DJ foi desconectado de 🔊 ${voiceName}.`,
      shutdown: `O Ghost DJ saiu de 🔊 ${voiceName}: o servidor está reiniciando.`,
    };
    this.#writePanel(s, `${why[reason]}\nUse /play para chamar de novo.`);
    try {
      s.output.clear();
    } catch {
      // already gone
    }
    await s.output.close().catch(() => undefined);
    await this.#d.voice.leaveLocal(this.#d.bot.botId).catch(() => undefined);
  }

  /** Stops the track in progress (skip, stop): the playback loop moves on, or ends. */
  #cut(s: Session): void {
    const source = s.source;
    s.source = null;
    source?.close();
    try {
      s.output.clear();
    } catch {
      // closed
    }
    this.#wake(s);
  }

  #wake(s: Session): void {
    const wake = s.wake;
    s.wake = null;
    wake?.();
  }

  #checkAlone(s: Session): void {
    const others = this.#d.voice.presentIn(s.voiceChannelId).filter((id) => id !== this.#d.bot.botId);
    if (others.length > 0) s.aloneSince = null;
    else s.aloneSince ??= this.#d.now();
  }

  /** Plays the queue until it is empty, then waits for the next /play (or the idle time). */
  async #run(s: Session): Promise<void> {
    if (s.running) return;
    s.running = true;
    try {
      while (!s.ended && s.current) {
        const track = s.current;
        const outcome = await this.#playTrack(s, track);
        if (s.ended) return;
        // A track that could not be played is noted on the panel while the next one plays.
        s.notice =
          outcome.kind === 'failed'
            ? `⚠️ Não consegui tocar **${chatText(track.title, 100)}**: ${trackErrorText(outcome.error, { hasCookies: this.#d.hasCookies() })}`
            : null;
        // A track that ends by itself plays again with "repetir a música"; a skip goes on.
        if (outcome.kind === 'ended' && s.loop === 'track') continue;
        if (outcome.kind !== 'failed' && s.loop === 'queue') s.queue.push(track);
        s.current = s.queue.shift() ?? null;
        this.#panel(s);
      }
    } finally {
      s.running = false;
      if (!s.ended && !s.current) {
        s.idleSince = this.#d.now();
        this.#panel(s);
      }
    }
  }

  async #playTrack(s: Session, track: DjTrack): Promise<Outcome> {
    const source = this.#d.openSource(track);
    s.source = source;
    s.frames = 0;
    if (!s.paused) s.idleSince = null;
    let carry: Buffer | null = null;
    const stopped = (): Outcome | null => (s.ended ? { kind: 'stopped' } : s.source !== source ? { kind: 'skipped' } : null);
    try {
      for await (const chunk of source.stream) {
        const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        let offset = 0;
        while (buf.length - offset >= FRAME_BYTES) {
          while (s.paused && !stopped()) await new Promise<void>((resolve) => (s.wake = resolve));
          const out = stopped();
          if (out) return out;
          await s.output.write(s.mixer.frame(buf, offset, FRAME_SAMPLES, gainOf(s.volume), this.#eq.gains));
          offset += FRAME_BYTES;
          if (++s.frames >= MAX_FRAMES) return { kind: 'ended' };
        }
        carry = offset < buf.length ? buf.subarray(offset) : null;
        const out = stopped();
        if (out) return out;
      }
      const out = stopped();
      if (out) return out;
      const error = await source.result();
      // Nothing (or almost nothing) came out: it could not be played.
      if (error !== null && s.frames < 50) return { kind: 'failed', error };
      if (s.frames === 0) return { kind: 'failed', error: error ?? 'failed' };
      return { kind: 'ended' };
    } catch (e) {
      const out = stopped();
      if (out) return out;
      this.#d.logger.warn('Ghost DJ: playback failed', { error: e instanceof Error ? e.message : String(e) });
      return { kind: 'failed', error: 'failed' };
    } finally {
      source.close();
      if (s.source === source) s.source = null;
    }
  }

  // ---- the "Tocando agora" panel ----

  #panelText(s: Session): string {
    const lines: string[] = [];
    if (s.current) {
      lines.push(`${s.paused ? '⏸️ **Pausado**' : '🎶 **Tocando agora**'} em 🔊 ${this.#voiceName(s.voiceChannelId)}`);
      lines.push(trackLine(s.current));
      lines.push(s.current.url);
    } else {
      lines.push(`🎶 O Ghost DJ está em 🔊 ${this.#voiceName(s.voiceChannelId)}, sem nada tocando. Use /play para pedir uma música.`);
    }
    if (s.queue.length > 0) {
      lines.push(`**Próximas:**`);
      s.queue.slice(0, GHOST_DJ_LIMITS.panelNext).forEach((t, i) => lines.push(`${i + 1}. ${trackLine(t)}`));
      if (s.queue.length > GHOST_DJ_LIMITS.panelNext) lines.push(`… e mais ${s.queue.length - GHOST_DJ_LIMITS.panelNext} na fila (/queue).`);
    }
    lines.push(`Volume ${s.volume} · Repetir: ${loopLabel(s.loop)}`);
    if (s.notice) lines.push(s.notice);
    return lines.join('\n');
  }

  /** The panel changed: written once after a short delay, whatever else changes meanwhile. */
  #panel(s: Session): void {
    if (s.ended) return;
    this.#d.onState();
    if (s.panelTimer) return;
    s.panelTimer = setTimeout(() => {
      s.panelTimer = null;
      if (!s.ended) this.#writePanel(s, this.#panelText(s));
    }, this.#d.panelDelayMs);
    s.panelTimer.unref();
  }

  /** Posts the panel in the channel of the first /play, or edits it; a deleted panel is posted again. */
  #writePanel(s: Session, content: string): void {
    try {
      if (s.panelId !== null) {
        try {
          this.#d.bot.editMessage(s.panelId, content);
          return;
        } catch (e) {
          if (!(e instanceof ProtocolError && e.code === 'NOT_FOUND')) throw e;
          s.panelId = null;
          if (s.ended) return;
        }
      }
      s.panelId = this.#d.bot.post(s.textChannelId, content).id;
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'RATE_LIMITED' && !s.ended) {
        // Too many changes at once: the next one (or this retry) writes the latest state.
        s.panelTimer ??= setTimeout(() => {
          s.panelTimer = null;
          if (!s.ended) this.#writePanel(s, this.#panelText(s));
        }, 2_000);
        s.panelTimer.unref();
        return;
      }
      this.#d.logger.warn('Ghost DJ: could not write the panel', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
