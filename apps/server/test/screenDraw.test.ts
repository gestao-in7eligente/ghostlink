// The pencil on shared screens, server side (spec 2026-10-01-lapis-na-tela-design.md §3, §5):
// the schema, who may draw on which share, the per-person limit, the relay to the voice channel
// only, and "Permitir desenhos" (only the sharer, back on for the next share).
import { afterEach, describe, expect, it } from 'vitest';
import {
  FEATURE_SCREEN_DRAW,
  PERMISSIONS,
  screenDrawAllowEventSchemaClient,
  screenDrawEventSchemaClient,
  screenDrawSchema,
  screenDrawWelcomeSchemaClient,
  type ResErr,
  type ResOk,
  type ScreenDrawEvent,
} from '@ghostlink/shared';
import { createScreenDrawModule, type ScreenDrawModule } from '../src/screenDraw/index.js';
import { createVoiceModule, type VoiceModule } from '../src/voice/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from './helpers/testClient.js';
import { FakeBackend, StubText } from './helpers/voice.js';

const servers: TestServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

interface Setup {
  text: StubText;
  backend: FakeBackend;
  voice: VoiceModule;
  draw: ScreenDrawModule;
  clock: { now: number };
  client(nickname?: string): Promise<TestClient>;
}

async function setup(o: { modules?: 'all' | 'noVoice' } = {}): Promise<Setup> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  text.channels.set('VC2', { type: 'voice', userLimit: 0 });
  const backend = new FakeBackend();
  const voice = createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  // The sweep runs by hand (draw.sweep()) so the tests decide when a share is over.
  const draw = createScreenDrawModule({ sweepIntervalMs: 3_600_000 });
  const clock = { now: Date.now() };
  const t = await startTestServer({
    joinMode: 'open',
    modules: o.modules === 'noVoice' ? [text, draw] : [text, voice, draw],
    now: () => clock.now,
    // The gateway's own 30 requests per second must not hide the module's limit; up to 8 people join.
    limits: { requestsPerSecondPerSession: 10_000, newIdentitiesPerIpPerHour: 50 },
  });
  servers.push(t);
  if (o.modules !== 'noVoice') await voice.whenReady();
  return {
    text,
    backend,
    voice,
    draw,
    clock,
    client: async (nickname) => {
      const c = await connectTestClient(t.server, nickname ? { nickname } : {});
      clients.push(c);
      return c;
    },
  };
}

function code(res: ResOk | ResErr): string {
  return res.ok ? 'OK' : res.error.code;
}

const identity = (c: TestClient) => `u_${c.identity.userId}`;

/** `c` joins the voice channel and LiveKit reports them in its room. */
async function enterVoice(s: Setup, c: TestClient, channelId: string): Promise<void> {
  expect(code(await c.request('voice.join', { channelId }))).toBe('OK');
  s.backend.join(`ch_${channelId}`, identity(c));
  await expect.poll(() => s.voice.registry.channelOf(c.identity.userId)).toBe(channelId);
}

/** LiveKit reports `c`'s screen track (start: published; stop: unpublished). */
function share(s: Setup, c: TestClient, channelId: string, on: boolean, trackSid = 'TR_screen'): void {
  const room = `ch_${channelId}`;
  const sid = s.backend.rooms.get(room)!.get(identity(c))!.sid;
  s.backend.emit({
    event: on ? 'track_published' : 'track_unpublished',
    room,
    identity: identity(c),
    participantSid: sid,
    track: { sid: trackSid, source: 'screen_share' },
  });
}

async function noEvent(c: TestClient, t: string, ms = 250): Promise<void> {
  await expect(c.waitEvent(t, ms)).rejects.toThrow(/no .* event/);
}

/** Drains the events of type `t` already received. */
async function drain(c: TestClient, t: string): Promise<void> {
  for (;;) {
    try {
      await c.waitEvent(t, 50);
    } catch {
      return;
    }
  }
}

const stroke = (sharerId: string, over: Record<string, unknown> = {}) => ({
  channelId: 'VC1',
  sharerId,
  strokeId: 'k3J_a-9',
  points: [
    [0.1, 0.2],
    [0.15, 0.25],
  ],
  end: false,
  ...over,
});

/** Ana shares in VC1; Bia and Caio are in VC1 too, Duda is in VC2, Eva is online but not in voice. */
async function room(s: Setup) {
  const ana = await s.client('Ana');
  const bia = await s.client('Bia');
  const caio = await s.client('Caio');
  const duda = await s.client('Duda');
  const eva = await s.client('Eva');
  await enterVoice(s, ana, 'VC1');
  await enterVoice(s, bia, 'VC1');
  await enterVoice(s, caio, 'VC1');
  await enterVoice(s, duda, 'VC2');
  share(s, ana, 'VC1', true);
  await expect.poll(() => s.voice.registry.state('VC1').participants.find((p) => p.userId === ana.identity.userId)?.screen).toBe(true);
  for (const c of [ana, bia, caio, duda, eva]) await drain(c, 'voice.state');
  return { ana, bia, caio, duda, eva };
}

describe('screen.draw schema (spec §3)', () => {
  const sharer = 'a'.repeat(32);
  const valid = stroke(sharer);
  it('takes 1 to 64 points between 0 and 1, a short stroke id and nothing else', () => {
    expect(screenDrawSchema.safeParse(valid).success).toBe(true);
    expect(screenDrawSchema.safeParse({ ...valid, points: [[0, 0], [1, 1]], end: true }).success).toBe(true);
    expect(screenDrawSchema.safeParse({ ...valid, points: Array.from({ length: 64 }, () => [0.5, 0.5]) }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['x above 1', { points: [[1.01, 0.5]] }],
    ['y below 0', { points: [[0.5, -0.001]] }],
    ['a point with three numbers', { points: [[0.5, 0.5, 0.5]] }],
    ['a point that is not numbers', { points: [['0.5', 0.5]] }],
    ['no point', { points: [] }],
    ['65 points', { points: Array.from({ length: 65 }, () => [0.5, 0.5]) }],
    ['a long stroke id', { strokeId: 'x'.repeat(33) }],
    ['a stroke id with other characters', { strokeId: 'a b' }],
    ['a sharer that is not a user id', { sharerId: 'Ana' }],
    ['an extra key', { color: '#ff0000' }],
    ['end that is not a boolean', { end: 1 }],
  ])('refuses %s', (_name, over) => {
    expect(screenDrawSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

describe('screen.draw (spec §3)', () => {
  it('announces the feature', async () => {
    const s = await setup();
    const ana = await s.client();
    expect(ana.welcome!.features).toContain(FEATURE_SCREEN_DRAW);
    expect(screenDrawWelcomeSchemaClient.parse(ana.rawWelcome!.screenDraw)).toEqual({ disallowed: [] });
  });

  it('does not announce it without voice (an old server has no pencil either)', async () => {
    const s = await setup({ modules: 'noVoice' });
    const ana = await s.client();
    expect(ana.welcome!.features).not.toContain(FEATURE_SCREEN_DRAW);
    expect(code(await ana.request('screen.draw', stroke(ana.identity.userId)))).toBe('FORBIDDEN');
  });

  it('relays a batch to the others in that voice channel only, never back to who drew it', async () => {
    const s = await setup();
    const { ana, bia, caio, duda, eva } = await room(s);
    const batch = stroke(ana.identity.userId, { end: true });
    expect(code(await bia.request('screen.draw', batch))).toBe('OK');
    const expected: ScreenDrawEvent = { ...(batch as unknown as ScreenDrawEvent), userId: bia.identity.userId };
    for (const c of [ana, caio]) expect(screenDrawEventSchemaClient.parse((await c.waitEvent('screen.draw')).d)).toEqual(expected);
    await noEvent(bia, 'screen.draw');
    await noEvent(duda, 'screen.draw');
    await noEvent(eva, 'screen.draw');
  });

  it('lets the sharer draw on their own share', async () => {
    const s = await setup();
    const { ana, bia } = await room(s);
    expect(code(await ana.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    expect((await bia.waitEvent('screen.draw')).d).toMatchObject({ sharerId: ana.identity.userId, userId: ana.identity.userId });
    await noEvent(ana, 'screen.draw');
  });

  it('refuses someone who is not in that voice channel, a share that does not exist and a hidden channel', async () => {
    const s = await setup();
    const { ana, bia, duda, eva } = await room(s);
    // In another voice channel, or in none.
    expect(code(await duda.request('screen.draw', stroke(ana.identity.userId)))).toBe('FORBIDDEN');
    expect(code(await eva.request('screen.draw', stroke(ana.identity.userId)))).toBe('FORBIDDEN');
    // Bia is in the channel but does not share.
    expect(code(await ana.request('screen.draw', stroke(bia.identity.userId)))).toBe('NOT_FOUND');
    expect(code(await ana.request('screen.draw', stroke(ana.identity.userId, { channelId: 'VC2' })))).toBe('FORBIDDEN');
    // A channel Bia cannot see answers like one that does not exist (spec §5.3).
    s.text.setBits(bia.identity.userId, 'VC1', 0);
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('NOT_FOUND');
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId, { channelId: 'NOPE' })))).toBe('NOT_FOUND');
    expect(code(await bia.request('screen.draw', { ...stroke(ana.identity.userId), extra: 1 }))).toBe('BAD_REQUEST');
    await noEvent(ana, 'screen.draw');
  });

  it('stops relaying when the share ends', async () => {
    const s = await setup();
    const { ana, bia } = await room(s);
    share(s, ana, 'VC1', false);
    await expect.poll(() => s.voice.registry.state('VC1').participants.find((p) => p.userId === ana.identity.userId)?.screen).toBe(false);
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('NOT_FOUND');
    await noEvent(ana, 'screen.draw');
  });

  it('does not relay to someone who lost sight of the channel', async () => {
    const s = await setup();
    const { ana, bia, caio } = await room(s);
    s.text.setBits(caio.identity.userId, 'VC1', 0);
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    await ana.waitEvent('screen.draw');
    await noEvent(caio, 'screen.draw');
  });

  it('drops batches above 30 per second per person without an error', async () => {
    const s = await setup();
    const { ana, bia, caio } = await room(s);
    for (let i = 0; i < 30; i++) expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    for (let i = 0; i < 30; i++) await ana.waitEvent('screen.draw');
    // The 31st in the same second: answered OK, relayed to nobody.
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    await noEvent(ana, 'screen.draw');
    // Someone else has their own budget.
    expect(code(await caio.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    expect((await ana.waitEvent('screen.draw')).d).toMatchObject({ userId: caio.identity.userId });
    // A second later Bia draws again.
    s.clock.now += 1_001;
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    expect((await ana.waitEvent('screen.draw')).d).toMatchObject({ userId: bia.identity.userId });
  });
});

describe('screen.drawAllow (spec §3)', () => {
  it('only the sharer turns drawing off; then nobody draws on that share, the sharer included', async () => {
    const s = await setup();
    const { ana, bia, caio } = await room(s);
    expect(code(await bia.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('FORBIDDEN');
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC2', allow: false }))).toBe('FORBIDDEN');
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false, sharerId: ana.identity.userId }))).toBe('BAD_REQUEST');
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('OK');
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('FORBIDDEN');
    expect(code(await ana.request('screen.draw', stroke(ana.identity.userId)))).toBe('FORBIDDEN');
    await noEvent(caio, 'screen.draw');
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: true }))).toBe('OK');
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    await caio.waitEvent('screen.draw');
  });

  it('announces the change to those who see the channel, in voice or not', async () => {
    const s = await setup();
    const { ana, bia, duda, eva } = await room(s);
    const fred = await s.client('Fred');
    s.text.setBits(fred.identity.userId, 'VC1', 0);
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('OK');
    const expected = { channelId: 'VC1', sharerId: ana.identity.userId, allow: false };
    // Duda (another voice channel) and Eva (no voice) see VC1 too: a later join already knows.
    for (const c of [ana, bia, duda, eva]) expect(screenDrawAllowEventSchemaClient.parse((await c.waitEvent('screen.drawAllow')).d)).toEqual(expected);
    await noEvent(fred, 'screen.drawAllow');
    // The same value again changes nothing.
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('OK');
    await noEvent(bia, 'screen.drawAllow');
    // A session that opens now gets it in its welcome.
    const late = await s.client('Gil');
    expect(screenDrawWelcomeSchemaClient.parse(late.rawWelcome!.screenDraw)).toEqual({ disallowed: [{ channelId: 'VC1', sharerId: ana.identity.userId }] });
  });

  it('is on again for the next share', async () => {
    const s = await setup();
    const { ana, bia } = await room(s);
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('OK');
    await bia.waitEvent('screen.drawAllow');
    s.draw.sweep();
    expect(s.draw.disallowed()).toHaveLength(1); // still sharing: kept
    share(s, ana, 'VC1', false);
    await expect.poll(() => s.voice.registry.state('VC1').participants.find((p) => p.userId === ana.identity.userId)?.screen).toBe(false);
    s.draw.sweep();
    expect(s.draw.disallowed()).toEqual([]);
    expect((await bia.waitEvent('screen.drawAllow')).d).toEqual({ channelId: 'VC1', sharerId: ana.identity.userId, allow: true });
    share(s, ana, 'VC1', true, 'TR_screen2');
    await expect.poll(() => s.voice.registry.state('VC1').participants.find((p) => p.userId === ana.identity.userId)?.screen).toBe(true);
    expect(code(await bia.request('screen.draw', stroke(ana.identity.userId)))).toBe('OK');
    await ana.waitEvent('screen.draw');
  });

  it('limits how often the sharer flips it', async () => {
    const s = await setup();
    const { ana } = await room(s);
    for (let i = 0; i < 10; i++) expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: i % 2 === 0 }))).toBe('OK');
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: true }))).toBe('RATE_LIMITED');
    s.clock.now += 10_001;
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: true }))).toBe('OK');
  });

  it('hides a disallowed share from the welcome of someone who cannot see the channel', async () => {
    const s = await setup();
    const { ana } = await room(s);
    expect(code(await ana.request('screen.drawAllow', { channelId: 'VC1', allow: false }))).toBe('OK');
    s.text.defaultBits = s.text.defaultBits & ~PERMISSIONS.VIEW_CHANNEL;
    s.text.setBits(ana.identity.userId, 'VC1', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CONNECT_VOICE);
    const stranger = await s.client('Ivo');
    expect(screenDrawWelcomeSchemaClient.parse(stranger.rawWelcome!.screenDraw)).toEqual({ disallowed: [] });
  });
});
