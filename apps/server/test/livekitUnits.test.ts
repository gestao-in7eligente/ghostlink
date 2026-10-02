import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrackSource } from 'livekit-server-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { loadOrCreateLivekitKeys, renderLivekitConfig, writeLivekitConfig, type LivekitConfigInput } from '../src/livekit/config.js';
import { verifyVoiceToken } from '../src/livekit/jwt.js';
import { createJoinToken, livekitPermission } from '../src/livekit/permissions.js';
import { livekitUrlFor } from '../src/voice/url.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-lk-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const USER = '0123456789abcdef0123456789abcdef';
const KEYS = { apiKey: 'GLtestkey123', apiSecret: 'a'.repeat(43) };
const input: LivekitConfigInput = {
  port: 17880,
  udpPort: 7882,
  tcpPort: 7881,
  nodeIp: '203.0.113.7',
  ...KEYS,
  webhookUrl: 'http://127.0.0.1:17881/livekit/webhook',
};

describe('data/livekit.yaml (spec §8.1)', () => {
  it('has exactly the verified keys and values', () => {
    expect(parse(renderLivekitConfig(input))).toEqual({
      port: 17880,
      bind_addresses: ['127.0.0.1'],
      rtc: { udp_port: 7882, tcp_port: 7881, use_external_ip: false, node_ip: '203.0.113.7', advertise_internal_ip: true },
      keys: { GLtestkey123: 'a'.repeat(43) },
      webhook: { api_key: 'GLtestkey123', urls: ['http://127.0.0.1:17881/livekit/webhook'] },
    });
  });

  it('refuses values that could inject YAML or point the webhook elsewhere', () => {
    expect(() => renderLivekitConfig({ ...input, nodeIp: '1.2.3.4\nturn:\n  enabled: true' })).toThrow();
    expect(() => renderLivekitConfig({ ...input, nodeIp: 'example.com' })).toThrow();
    expect(() => renderLivekitConfig({ ...input, apiKey: 'key: x' })).toThrow();
    expect(() => renderLivekitConfig({ ...input, apiSecret: 'short' })).toThrow();
    expect(() => renderLivekitConfig({ ...input, webhookUrl: 'http://10.0.0.1:1/livekit/webhook' })).toThrow();
    expect(() => renderLivekitConfig({ ...input, port: 0 })).toThrow();
    expect(() => renderLivekitConfig({ ...input, udpPort: 70000 })).toThrow();
  });

  it("behind a TCP proxy: ICE-TCP only, on the proxy's external port, one loopback candidate announced as the proxy's IP (spec §8.6)", () => {
    const proxied: LivekitConfigInput = { ...input, tcpPort: 25_889, nodeIp: '66.33.22.220', behindProxy: true };
    expect(parse(renderLivekitConfig(proxied))).toEqual({
      port: 17880,
      bind_addresses: ['127.0.0.1'],
      rtc: {
        // LiveKit listens on the external port and announces it: the proxy maps that port to ours.
        tcp_port: 25_889,
        // No UDP socket at all: nothing could reach it, and no client waits on UDP candidates.
        force_tcp: true,
        use_external_ip: false,
        node_ip: '66.33.22.220',
        // The public port pipes ICE-TCP to 127.0.0.1, and pion's TCP mux finds each connection by
        // the local address it arrived on: the only host candidate is loopback, rewritten to node_ip.
        enable_loopback_candidate: true,
        ips: { includes: ['127.0.0.1/32'] },
      },
      keys: { GLtestkey123: 'a'.repeat(43) },
      webhook: { api_key: 'GLtestkey123', urls: ['http://127.0.0.1:17881/livekit/webhook'] },
    });
    // An IPv6 node_ip would not rewrite the IPv4 loopback candidate: 127.0.0.1 would be announced.
    expect(() => renderLivekitConfig({ ...proxied, nodeIp: '2001:db8::1' })).toThrow(/IPv4/);
    expect(() => renderLivekitConfig({ ...proxied, tcpPort: 0 })).toThrow();
  });

  it('writes the file readable by the owner only', () => {
    const dir = tempDir();
    const path = writeLivekitConfig(dir, input);
    expect(readFileSync(path, 'utf8')).toBe(renderLivekitConfig(input));
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('LiveKit API keys', () => {
  it('are generated once, 256-bit secret, 0600, and reused', () => {
    const dir = tempDir();
    const keys = loadOrCreateLivekitKeys(dir);
    expect(keys.apiSecret.length).toBeGreaterThanOrEqual(43);
    expect(Buffer.from(keys.apiSecret, 'base64url')).toHaveLength(32);
    expect(loadOrCreateLivekitKeys(dir)).toEqual(keys);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'livekit-keys.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses a corrupt key file instead of silently replacing it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'livekit-keys.json'), JSON.stringify({ apiKey: 'x', apiSecret: 'short' }));
    expect(() => loadOrCreateLivekitKeys(dir)).toThrow(/corrupt/);
  });
});

describe('livekitPermission (spec §6)', () => {
  const P = PERMISSIONS;

  it('never pairs canPublish: true with an empty source list', () => {
    for (let bits = 0; bits <= (P.SPEAK | P.VIDEO | P.CONNECT_VOICE | P.VIEW_CHANNEL); bits++) {
      for (const serverMuted of [false, true]) {
        const p = livekitPermission(bits, { serverMuted });
        expect(p.canPublish).toBe(p.canPublishSources.length > 0);
      }
    }
  });

  it('maps SPEAK to the microphone and VIDEO to camera and screen, and a server mute removes only the microphone', () => {
    expect(livekitPermission(DEFAULT_EVERYONE_PERMISSIONS, { serverMuted: false }).canPublishSources).toEqual([
      TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO,
    ]);
    expect(livekitPermission(P.SPEAK, { serverMuted: false })).toEqual({
      canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: [TrackSource.MICROPHONE], canUpdateMetadata: false, hidden: false,
    });
    expect(livekitPermission(P.SPEAK, { serverMuted: true })).toMatchObject({ canPublish: false, canPublishSources: [] });
    expect(livekitPermission(P.VIDEO | P.SPEAK, { serverMuted: true }).canPublishSources).not.toContain(TrackSource.MICROPHONE);
    expect(livekitPermission(0, { serverMuted: false })).toMatchObject({ canSubscribe: true, canPublish: false, canPublishData: false, hidden: false });
    expect(livekitPermission(ALL_PERMISSIONS, { serverMuted: false }).canPublishData).toBe(false);
    // A server deafen takes the subscriptions away and leaves publishing alone.
    expect(livekitPermission(P.SPEAK, { serverMuted: false, serverDeafened: true })).toMatchObject({ canSubscribe: false, canPublish: true, canPublishSources: [TrackSource.MICROPHONE] });
  });
});

function payloadOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function sign(payload: Record<string, unknown>, opts: { secret?: string; header?: Record<string, unknown> } = {}): string {
  const header = Buffer.from(JSON.stringify(opts.header ?? { alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', opts.secret ?? KEYS.apiSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

describe('join token (spec §8.2)', () => {
  it('carries the room, identity, name, metadata, 60 s TTL and the permission block', async () => {
    const jwt = await createJoinToken({ ...KEYS, userId: USER, channelId: 'VC1', nickname: 'Ana', permission: livekitPermission(PERMISSIONS.SPEAK, { serverMuted: false }) });
    const claims = payloadOf(jwt);
    expect(claims).toMatchObject({ iss: KEYS.apiKey, sub: `u_${USER}`, name: 'Ana', metadata: JSON.stringify({ userId: USER }) });
    expect(Number(claims.exp) - Number(claims.nbf ?? claims.iat)).toBeLessThanOrEqual(60);
    expect(claims.video).toEqual({
      roomJoin: true, room: 'ch_VC1', canSubscribe: true, canPublish: true, canPublishData: false,
      canPublishSources: ['microphone'], canUpdateOwnMetadata: false, hidden: false,
    });
    expect(verifyVoiceToken(jwt, { ...KEYS, nowMs: Date.now() })).toEqual({ userId: USER, channelId: 'VC1' });
  });

  it('a server-muted SPEAK-only user may publish nothing', async () => {
    const jwt = await createJoinToken({ ...KEYS, userId: USER, channelId: 'VC1', nickname: 'Ana', permission: livekitPermission(PERMISSIONS.SPEAK, { serverMuted: true }) });
    const video = payloadOf(jwt).video as Record<string, unknown>;
    expect(video.canPublish).toBe(false);
  });
});

describe('verifyVoiceToken: the /rtc proxy authorization (spec §4)', () => {
  const now = 1_800_000_000_000;
  const good = { iss: KEYS.apiKey, sub: `u_${USER}`, exp: now / 1000 + 600, nbf: now / 1000 - 5, video: { roomJoin: true, room: 'ch_VC1' } };
  const verify = (t: string) => verifyVoiceToken(t, { ...KEYS, nowMs: now });

  it('accepts LiveKit refresh tokens: same secret, sub and room, ~10 min validity, no GhostLink claim', () => {
    expect(verify(sign({ ...good, name: 'Ana', video: { ...good.video, canPublish: true, canSubscribe: true } }))).toEqual({ userId: USER, channelId: 'VC1' });
    expect(verify(sign({ ...good, nbf: undefined }))).toEqual({ userId: USER, channelId: 'VC1' });
  });

  it('refuses forged, downgraded or foreign tokens', () => {
    expect(verify(sign(good, { secret: 'b'.repeat(43) }))).toBeNull();
    expect(verify(sign(good, { header: { alg: 'none' } }))).toBeNull();
    expect(verify(sign(good, { header: { alg: 'HS512' } }))).toBeNull();
    expect(verify(sign(good, { header: { alg: 'HS256', crit: ['x'] } }))).toBeNull();
    const [h, p] = sign(good).split('.');
    expect(verify(`${h}.${p}.`)).toBeNull();
    expect(verify(`${h}.${p}`)).toBeNull();
    const tampered = sign(good).split('.');
    tampered[1] = Buffer.from(JSON.stringify({ ...good, sub: 'u_ffffffffffffffffffffffffffffffff' })).toString('base64url');
    expect(verify(tampered.join('.'))).toBeNull();
    expect(verify(sign({ ...good, iss: 'other' }))).toBeNull();
  });

  it('refuses expired, not-yet-valid and wrongly scoped tokens', () => {
    expect(verify(sign({ ...good, exp: now / 1000 - 60 }))).toBeNull();
    expect(verify(sign({ ...good, exp: undefined }))).toBeNull();
    expect(verify(sign({ ...good, nbf: now / 1000 + 120 }))).toBeNull();
    expect(verify(sign({ ...good, video: { roomJoin: false, room: 'ch_VC1' } }))).toBeNull();
    expect(verify(sign({ ...good, video: { roomJoin: true, room: 'lobby' } }))).toBeNull();
    expect(verify(sign({ ...good, video: { roomAdmin: true, room: 'ch_VC1' } }))).toBeNull();
    expect(verify(sign({ ...good, sub: 'agent-1' }))).toBeNull();
    expect(verify('')).toBeNull();
    expect(verify('x'.repeat(10_000))).toBeNull();
    expect(verify('not.a.jwt')).toBeNull();
  });
});

describe('livekitUrlFor: the voice.join URL (spec §8.2)', () => {
  const fallback = 'voice.example.com:7700';

  it('echoes the host:port the client connected to, normalized', () => {
    expect(livekitUrlFor('127.0.0.1:7700', fallback)).toBe('wss://127.0.0.1:7700');
    expect(livekitUrlFor('LocalHost:7710', fallback)).toBe('wss://localhost:7710');
    expect(livekitUrlFor('[::1]:7700', fallback)).toBe('wss://[::1]:7700');
    expect(livekitUrlFor('[0:0:0:0:0:0:0:1]:7700', fallback)).toBe('wss://[::1]:7700');
    // No port in Host means the client used the scheme's default port, so none is added.
    expect(livekitUrlFor('ghost.example.com', fallback)).toBe('wss://ghost.example.com');
  });

  it('falls back to the public address when the Host header is missing or is not a plain host[:port]', () => {
    for (const bad of [undefined, '', 'a b:7700', 'host/path', 'host:7700/x', 'user@host:7700', 'host:0', 'host:99999', '::1', 'h:7700?q', 'x'.repeat(300)]) {
      expect(livekitUrlFor(bad, fallback)).toBe('wss://voice.example.com:7700');
    }
  });
});
