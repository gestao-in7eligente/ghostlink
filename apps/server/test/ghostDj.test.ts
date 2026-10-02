import { describe, expect, it } from 'vitest';
import {
  FEATURE_GHOST_DJ,
  FEATURE_GHOST_DJ_PANEL,
  botsWelcomeSchemaClient,
  type BotInfo,
  type GhostDjState,
  type InteractionEphemeralEvent,
  type Member,
  type Message,
  type VoiceChannelState,
} from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule } from '../src/bots/index.js';
import { FRAME_BYTES, createGhostDjModule, type AudioOutput, type DjTrack, type GhostDjModule, type PcmSource, type ResolveResult, type TrackError } from '../src/ghostDj/index.js';
import type { PlayTarget } from '../src/ghostDj/youtube.js';
import { silentLogger, startServer } from '../src/index.js';
import { createTextModule } from '../src/text/index.js';
import { createVoiceModule } from '../src/voice/index.js';
import { FakeBackend } from './helpers/voice.js';
import { channelId, textFixture, type TextClient, type TextFixture } from './text/helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A track's PCM that plays until the test ends it (finish) or the DJ stops it (close). */
class FakeSource implements PcmSource {
  closed = false;
  #done = false;
  constructor(
    readonly track: DjTrack,
    readonly fail: TrackError | null,
  ) {}
  readonly stream = this.#frames();
  async *#frames(): AsyncGenerator<Buffer> {
    while (!this.fail && !this.closed && !this.#done) {
      yield Buffer.alloc(FRAME_BYTES * 2, 0x10);
      await sleep(1);
    }
  }
  finish(): void {
    this.#done = true;
  }
  close(): void {
    this.closed = true;
  }
  result(): Promise<TrackError | null> {
    return Promise.resolve(this.fail);
  }
}

/** LiveKit as the DJ sees it: the token's room and identity join the fake backend's room. */
class FakeOutput implements AudioOutput {
  frames = 0;
  closed = false;
  url = '';
  claims: { sub: string; video: { room: string; canSubscribe: boolean; canPublishSources: string[] } } | null = null;
  #listener: (() => void) | null = null;
  constructor(private readonly backend: FakeBackend) {}
  async connect(url: string, token: string): Promise<void> {
    this.url = url;
    this.claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    this.backend.join(this.claims!.video.room, this.claims!.sub);
  }
  async write(): Promise<void> {
    this.frames++;
    await sleep(1);
  }
  clear(): void {}
  async close(): Promise<void> {
    this.closed = true;
  }
  onClosed(listener: () => void): void {
    this.#listener = listener;
  }
  /** LiveKit dropped it (kicked, LiveKit down). */
  drop(): void {
    this.#listener?.();
  }
}

interface Dj {
  fx: TextFixture;
  backend: FakeBackend;
  module: GhostDjModule;
  djId: string;
  geral: string;
  sala: string;
  sources: FakeSource[];
  outputs: FakeOutput[];
  /** What the fake yt-dlp answers, by the target's url (default: one track named after it). */
  answers: Map<string, ResolveResult>;
  /** Track ids whose playback fails with this error. */
  failing: Map<string, TrackError>;
}

let ids = 0;
const track = (title: string, durationSec = 200) => ({ id: `vid${String(++ids).padStart(8, '0')}`, title, url: `https://www.youtube.com/watch?v=${title}`, durationSec });

async function setup(o: { ffmpeg?: string | null } = {}): Promise<Dj> {
  const backend = new FakeBackend();
  const sources: FakeSource[] = [];
  const outputs: FakeOutput[] = [];
  const answers = new Map<string, ResolveResult>();
  const failing = new Map<string, TrackError>();
  const module = createGhostDjModule({
    ffmpeg: o.ffmpeg === undefined ? 'ffmpeg-fake' : o.ffmpeg,
    ytdlp: false,
    resolve: async (target: PlayTarget) => {
      await sleep(5);
      return answers.get(target.url) ?? { ok: true, tracks: [track(target.kind === 'search' ? target.query : target.id)], playlistTitle: null, skipped: 0 };
    },
    openSource: (t) => {
      const source = new FakeSource(t, failing.get(t.title) ?? null);
      sources.push(source);
      return source;
    },
    createOutput: async () => {
      const output = new FakeOutput(backend);
      outputs.push(output);
      return output;
    },
    panelDelayMs: 10,
    stateDelayMs: 5,
    tickMs: 3_600_000,
  });
  const fx = await textFixture({
    text: { rateLimits: { msgSendBurst: 1_000 } },
    extraModules: [
      createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 }),
      createAvatarsModule(),
      createBotsModule(),
      module,
    ],
  });
  return { fx, backend, module, djId: module.botId!, geral: channelId(fx.owner, 'geral'), sala: channelId(fx.owner, 'Sala de voz'), sources, outputs, answers, failing };
}

/** `c` joins the voice channel and LiveKit reports them in its room. */
async function enterVoice(d: Dj, c: TextClient, channel: string): Promise<void> {
  await c.ok('voice.join', { channelId: channel });
  d.backend.join(`ch_${channel}`, `u_${c.userId}`);
}

/** Uses a DJ command (a second apart: the invoke limit is per channel per second). */
async function use(d: Dj, c: TextClient, command: string, options: { name: string; value: string | number }[] = [], channel = d.geral): Promise<string> {
  d.fx.clock.now += 1_000;
  const { id } = await c.ok<{ id: string }>('interaction.invoke', { channelId: channel, botId: d.djId, command, options });
  return id;
}

/** The answer only `c` sees (the last version of it). */
async function privateAnswer(c: TextClient, id: string, match?: RegExp): Promise<string> {
  return (await c.event<InteractionEphemeralEvent>('interaction.ephemeral', (e) => e.interactionId === id && (!match || match.test(e.content)))).content;
}

/** The public answer to an interaction. */
async function publicAnswer(c: TextClient, id: string): Promise<Message> {
  return (await c.event<{ message: Message }>('msg.new', (e) => e.message.interaction?.id === id)).message;
}

const djState = (d: Dj) => d.module.dj!.state;

/** The DJ's panel (posted or edited) as `c` saw it, once it contains `text`. */
async function panelWith(d: Dj, c: TextClient, text: string): Promise<Message> {
  const find = () =>
    c.events
      .filter((e) => e.t === 'msg.new' || e.t === 'msg.updated')
      .map((e) => (e.d as { message: Message }).message)
      .find((m) => m.authorId === d.djId && m.interaction === null && m.content.includes(text));
  await expect.poll(find).toBeDefined();
  return find()!;
}

describe('Ghost DJ: the system bot (spec §1, §2)', () => {
  it('exists in every server with its commands and photo, cannot be deleted nor get a code, and announces the flag', async () => {
    const d = await setup();
    const welcome = d.fx.owner.welcome as { features: string[]; members: Member[] };
    expect(welcome.features).toContain(FEATURE_GHOST_DJ);
    const member = d.fx.owner.text.members.find((m) => m.userId === d.djId)!;
    expect(member).toMatchObject({ nickname: 'Ghost DJ', bot: true, online: true });
    expect(member.avatar).toMatch(/^[0-9a-f]{64}$/);
    const bots = botsWelcomeSchemaClient.parse(d.fx.owner.welcome);
    expect(bots.botCommands.find((c) => c.botId === d.djId)?.commands.map((c) => c.name)).toEqual(['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'volume', 'loop']);
    expect(bots.botProfiles?.find((p) => p.botId === d.djId)?.system).toBe(true);

    const { bots: list } = await d.fx.owner.ok<{ bots: BotInfo[] }>('bot.list');
    expect(list).toEqual([expect.objectContaining({ userId: d.djId, system: true, createdBy: null })]);
    expect(await d.fx.owner.fail('bot.regenerate', { botId: d.djId })).toBe('FORBIDDEN');
    expect(await d.fx.owner.fail('bot.delete', { botId: d.djId })).toBe('FORBIDDEN');
  });

  it('without ffmpeg the flag is off and /play says why', async () => {
    const d = await setup({ ffmpeg: null });
    expect((d.fx.owner.welcome as { features: string[] }).features).not.toContain(FEATURE_GHOST_DJ);
    await enterVoice(d, d.fx.owner, d.sala);
    const id = await use(d, d.fx.owner, 'play', [{ name: 'busca', value: 'qualquer' }]);
    expect(await privateAnswer(d.fx.owner, id)).toMatch(/ffmpeg/);
  });
});

describe('Ghost DJ: playing (spec §1)', () => {
  it('/play joins the caller’s channel, plays, queues and keeps one "Tocando agora" panel up to date', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);

    const first = await use(d, ana, 'play', [{ name: 'busca', value: 'primeira musica' }]);
    expect(await privateAnswer(ana, first, /Tocando agora/)).toContain('primeira musica');
    // A LiveKit participant in that room, with a token that may only publish its microphone.
    expect(d.outputs).toHaveLength(1);
    expect(d.outputs[0]!.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(d.outputs[0]!.claims!.video).toMatchObject({ room: `ch_${d.sala}`, canSubscribe: false, canPublishSources: ['microphone'] });
    await ana.event<VoiceChannelState>('voice.state', (s) => s.channelId === d.sala && s.participants.some((p) => p.userId === d.djId));
    await expect.poll(() => d.outputs[0]!.frames).toBeGreaterThan(0);

    const panel = (await ana.event<{ message: Message }>('msg.new', (e) => e.message.authorId === d.djId && e.message.interaction === null)).message;
    expect(panel.channelId).toBe(d.geral);
    expect(panel.content).toContain('Tocando agora');
    expect(panel.content).toContain('primeira musica');

    const second = await use(d, ana, 'play', [{ name: 'busca', value: 'segunda musica' }]);
    expect(await privateAnswer(ana, second, /Na fila/)).toContain('segunda musica');
    await ana.event<{ message: Message }>('msg.updated', (e) => e.message.id === panel.id && e.message.content.includes('segunda musica'));
    expect(djState(d)).toMatchObject({ current: { title: 'primeira musica' }, queue: [{ title: 'segunda musica' }], volume: 50, loop: 'off' });

    // The first track ends by itself: the next one starts.
    d.sources[0]!.finish();
    await expect.poll(() => djState(d)?.current?.title).toBe('segunda musica');
    expect(d.sources).toHaveLength(2);
    // One panel, edited; never a second one.
    expect(ana.seen<{ message: Message }>('msg.new').filter((e) => e.message.authorId === d.djId && e.message.interaction === null)).toHaveLength(1);
  });

  it('pause, resume, volume, loop, skip and stop answer in public; only people in its channel control it', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    const bia = await d.fx.join({ nickname: 'bia' });
    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'um' }]), /Tocando/);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'dois' }]), /Na fila/);

    // Bia is not in its voice channel: she may look, not control.
    expect(await privateAnswer(bia, await use(d, bia, 'pause'))).toContain('Entre em 🔊 Sala de voz');
    expect(await privateAnswer(bia, await use(d, bia, 'queue'))).toMatch(/Tocando:.*um[\s\S]*1\. \*\*dois\*\*/);
    expect(djState(d)!.paused).toBe(false);

    expect((await publicAnswer(ana, await use(d, ana, 'pause'))).content).toContain('pausou');
    expect(djState(d)!.paused).toBe(true);
    expect(await privateAnswer(ana, await use(d, ana, 'pause'))).toContain('já está pausada');
    const frames = d.outputs[0]!.frames;
    await sleep(30);
    expect(d.outputs[0]!.frames - frames).toBeLessThanOrEqual(1);
    expect((await publicAnswer(ana, await use(d, ana, 'resume'))).content).toContain('continuou');
    await expect.poll(() => d.outputs[0]!.frames).toBeGreaterThan(frames + 2);

    expect(await privateAnswer(ana, await use(d, ana, 'volume', [{ name: 'nivel', value: 150 }]))).toContain('0 a 100');
    expect((await publicAnswer(ana, await use(d, ana, 'volume', [{ name: 'nivel', value: 30 }]))).content).toContain('30');
    expect((await publicAnswer(ana, await use(d, ana, 'loop', [{ name: 'modo', value: 'musica' }]))).content).toContain('repetindo a música');
    expect(djState(d)).toMatchObject({ volume: 30, loop: 'track' });

    // "Repetir a música": a track that ends plays again; /skip still moves on.
    d.sources[0]!.finish();
    await expect.poll(() => d.sources.length).toBe(2);
    expect(djState(d)!.current!.title).toBe('um');
    expect((await publicAnswer(ana, await use(d, ana, 'skip'))).content).toContain('pulou **um**');
    await expect.poll(() => djState(d)?.current?.title).toBe('dois');

    expect((await publicAnswer(ana, await use(d, ana, 'nowplaying'))).content).toContain('dois');
    expect((await publicAnswer(ana, await use(d, ana, 'stop'))).content).toContain('parou');
    await expect.poll(() => d.outputs[0]!.closed).toBe(true);
    expect(djState(d)).toBeNull();
    await ana.event<VoiceChannelState>('voice.state', (s) => s.channelId === d.sala && !s.participants.some((p) => p.userId === d.djId));
    expect(d.backend.removals()).toContain(`ch_${d.sala}/u_${d.djId}`);
    expect(await privateAnswer(ana, await use(d, ana, 'skip'))).toContain('não está tocando');
  });

  it('/play needs a voice channel, a YouTube link or a name, and the DJ free or in the same channel', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    const bia = await d.fx.join({ nickname: 'bia' });
    expect(await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'algo' }]))).toContain('Entre num canal de voz');
    await enterVoice(d, ana, d.sala);
    expect(await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'https://vimeo.com/123' }]))).toContain('Não consigo tocar isso');

    d.answers.set('ytsearch1:bloqueado', { ok: false, error: 'blocked' });
    expect(await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'bloqueado' }]), /YouTube/)).toContain('ghost-dj/cookies.txt');

    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'tocando aqui' }]), /Tocando/);
    const { channel } = await d.fx.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'Outra sala', type: 'voice' });
    await enterVoice(d, bia, channel.id);
    expect(await privateAnswer(bia, await use(d, bia, 'play', [{ name: 'busca', value: 'outra' }]))).toContain('O Ghost DJ está tocando em 🔊 Sala de voz');
  });

  it('a playlist fills the queue up to its limit; a track that cannot be played is skipped with a notice on the panel', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);
    const list = Array.from({ length: 50 }, (_, i) => track(`item ${i + 1}`));
    d.answers.set('https://www.youtube.com/playlist?list=PLtest123', { ok: true, tracks: list, playlistTitle: 'Minha *lista*', skipped: 2 });
    d.failing.set('item 1', 'unavailable');
    const id = await use(d, ana, 'play', [{ name: 'busca', value: 'https://www.youtube.com/playlist?list=PLtest123' }]);
    const answer = await privateAnswer(ana, id, /músicas/);
    expect(answer).toContain('50 músicas da playlist **Minha \\*lista\\***');
    expect(answer).toContain('2 ficaram de fora');
    await expect.poll(() => djState(d)?.current?.title).toBe('item 2');
    await panelWith(d, ana, 'Não consegui tocar **item 1**: Esse vídeo não está disponível');
    expect(djState(d)!.queue).toHaveLength(48);
  });
});

describe('Ghost DJ: leaving by itself (spec §1)', () => {
  it('leaves after 5 minutes without playing', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'curta' }]), /Tocando/);
    d.sources[0]!.finish();
    await expect.poll(() => djState(d)?.current ?? null).toBeNull();
    d.fx.clock.now += 4 * 60_000;
    d.module.tick();
    expect(djState(d)).not.toBeNull();
    d.fx.clock.now += 61_000;
    d.module.tick();
    await expect.poll(() => d.outputs[0]!.closed).toBe(true);
    expect(djState(d)).toBeNull();
    await panelWith(d, ana, '5 minutos sem tocar');
  });

  it('stops when LiveKit drops it, and says so on the panel', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'qualquer' }]), /Tocando/);
    await panelWith(d, ana, 'Tocando agora');
    d.outputs[0]!.drop();
    await panelWith(d, ana, 'foi desconectado');
    expect(djState(d)).toBeNull();
    expect(d.sources[0]!.closed).toBe(true);
    // It can be called again at once.
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'de novo' }]), /Tocando/);
    expect(d.outputs).toHaveLength(2);
  });

  it('leaves once nobody else is in its channel', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'longa' }]), /Tocando/);
    await ana.ok('voice.leave', {});
    await expect.poll(() => d.module.dj!.channelId).toBe(d.sala);
    d.fx.clock.now += 16_000;
    d.module.tick();
    await expect.poll(() => d.outputs[0]!.closed).toBe(true);
    expect(djState(d)).toBeNull();
  });
});

describe('Ghost DJ: the panel (spec 2026-10-02-ghost-dj-som-e-equalizador §2)', () => {
  it('anyone reads the state; only people in its channel change the equalizer, the volume or the playback', async () => {
    const d = await setup();
    expect((d.fx.owner.welcome as { features: string[] }).features).toContain(FEATURE_GHOST_DJ_PANEL);
    const ana = await d.fx.join({ nickname: 'ana' });
    const bia = await d.fx.join({ nickname: 'bia' });
    // Nothing playing: flat equalizer, and nobody may change anything.
    expect(await bia.ok<GhostDjState>('dj.state', {})).toMatchObject({ channelId: null, current: null, eq: { preset: 'default', gains: [0, 0, 0, 0, 0] } });
    expect(await ana.fail('dj.eq', { preset: 'rock' })).toBe('FORBIDDEN');

    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'um' }]), /Tocando/);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'dois' }]), /Na fila/);
    expect(await bia.ok<GhostDjState>('dj.state', {})).toMatchObject({
      channelId: d.sala,
      current: { title: 'um', requesterName: 'ana', requestedBy: ana.userId },
      next: [{ title: 'dois' }],
      queueLength: 1,
      volume: 50,
      paused: false,
    });

    // Bia is not in its voice channel: read only, as with the slash commands.
    expect(await bia.fail('dj.eq', { preset: 'rock' })).toBe('FORBIDDEN');
    expect(await bia.fail('dj.volume', { volume: 10 })).toBe('FORBIDDEN');
    expect(await bia.fail('dj.control', { action: 'pause' })).toBe('FORBIDDEN');
    expect(await ana.fail('dj.eq', { gains: [13, 0, 0, 0, 0] })).toBe('BAD_REQUEST');
    expect(await ana.fail('dj.eq', { preset: 'jazz' })).toBe('BAD_REQUEST');

    // Ana is: a preset, then a band by hand ("Personalizado"); every panel hears of it.
    expect((await ana.ok<GhostDjState>('dj.eq', { preset: 'bass' })).eq).toEqual({ preset: 'bass', gains: [6, 4, 0, 0, 0] });
    expect((await bia.event<GhostDjState>('dj.state', (s) => s.eq.preset === 'bass')).current?.title).toBe('um');
    expect((await ana.ok<GhostDjState>('dj.eq', { gains: [6, 4, 0, 0, 3] })).eq).toEqual({ preset: 'custom', gains: [6, 4, 0, 0, 3] });
    expect((await ana.ok<GhostDjState>('dj.volume', { volume: 80 })).volume).toBe(80);
    expect(djState(d)!.volume).toBe(80);

    expect((await ana.ok<GhostDjState>('dj.control', { action: 'pause' })).paused).toBe(true);
    await bia.event<GhostDjState>('dj.state', (s) => s.paused);
    expect((await ana.ok<GhostDjState>('dj.control', { action: 'resume' })).paused).toBe(false);
    await ana.ok('dj.control', { action: 'skip' });
    await expect.poll(() => djState(d)?.current?.title).toBe('dois');
    await bia.event<GhostDjState>('dj.state', (s) => s.current?.title === 'dois' && s.queueLength === 0);
    expect(await ana.ok<GhostDjState>('dj.control', { action: 'stop' })).toMatchObject({ channelId: null, current: null });
    await expect.poll(() => d.outputs[0]!.closed).toBe(true);
    await bia.event<GhostDjState>('dj.state', (s) => s.channelId === null);
    expect(await ana.fail('dj.control', { action: 'skip' })).toBe('FORBIDDEN');
  });

  it('someone who cannot see its voice channel gets the state without it', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    const bia = await d.fx.join({ nickname: 'bia' });
    const { role } = await d.fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Música' });
    for (const userId of [ana.userId, d.djId]) await d.fx.owner.ok('member.setRoles', { userId, roleIds: [role.id] });
    const { channel } = await d.fx.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'Privada', type: 'voice', private: true, allowedRoleIds: [role.id] });
    await ana.sync();
    await enterVoice(d, ana, channel.id);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'segredo' }]), /Tocando/);
    await d.fx.owner.ok('dj.state', {});
    expect(await ana.ok<GhostDjState>('dj.state', {})).toMatchObject({ channelId: channel.id, current: { title: 'segredo' } });
    expect(await bia.ok<GhostDjState>('dj.state', {})).toMatchObject({ channelId: null, current: null, next: [], queueLength: 0 });
    await ana.ok('dj.eq', { preset: 'pop' });
    const seen = await bia.event<GhostDjState>('dj.state', (s) => s.eq.preset === 'pop');
    expect(seen).toMatchObject({ channelId: null, current: null });
  });

  it('the equalizer is the server’s: it outlives the session and a restart', async () => {
    const d = await setup();
    const ana = await d.fx.join({ nickname: 'ana' });
    await enterVoice(d, ana, d.sala);
    await privateAnswer(ana, await use(d, ana, 'play', [{ name: 'busca', value: 'um' }]), /Tocando/);
    await ana.ok('dj.eq', { gains: [-3, 0, 2, 5, 12] });
    await ana.ok('dj.control', { action: 'stop' });
    expect((await ana.ok<GhostDjState>('dj.state', {})).eq).toEqual({ preset: 'custom', gains: [-3, 0, 2, 5, 12] });
    await d.fx.t.server.close();

    const again = createGhostDjModule({ ffmpeg: 'ffmpeg-fake', ytdlp: false, tickMs: 3_600_000 });
    const backend = new FakeBackend();
    const server = await startServer({
      dataDir: d.fx.t.dataDir,
      port: 0,
      host: '127.0.0.1',
      logger: silentLogger,
      modules: [createTextModule(), createVoiceModule({ backend: () => backend }), createAvatarsModule(), createBotsModule(), again],
    });
    try {
      expect(again.dj!.view().eq).toEqual({ preset: 'custom', gains: [-3, 0, 2, 5, 12] });
    } finally {
      await server.close();
    }
  });
});
