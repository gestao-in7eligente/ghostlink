import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger.js';
import { LivekitBackend, freeLoopbackPort, type VoiceWebhookEvent } from '../../src/livekit/backend.js';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import { LivekitProcess } from '../../src/livekit/process.js';
import { freeMediaPorts } from '../helpers/voice.js';

// Real livekit-server (spec §14 "Integração LiveKit"); skipped when scripts/fetch-livekit.mjs has not run.
const binary = resolveLivekitBinary();
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-lkp-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const randomMediaPorts = freeMediaPorts;

describe.skipIf(!binary)('livekit-server process (real binary)', () => {
  it('boots in strict mode with the generated config, answers RoomService, and stops', async () => {
    const dataDir = tempDir();
    const events: VoiceWebhookEvent[] = [];
    let ready = 0;
    const backend = new LivekitBackend({ binaryPath: binary!, dataDir, logger: silentLogger, nodeIp: '127.0.0.1', ...(await randomMediaPorts()) });
    cleanups.push(() => backend.stop());
    await backend.start({ onReady: () => ready++, onWebhook: (e) => events.push(e), onUnavailable: () => {} });
    expect(backend.available).toBe(true);
    expect(ready).toBe(1);
    expect(backend.signalPort).toBeGreaterThan(0);
    expect(await backend.listRooms()).toEqual([]);
    expect(await backend.listParticipants('ch_nobody')).toEqual([]);
    await backend.removeParticipant('ch_nobody', 'u_0123456789abcdef0123456789abcdef'); // not found is ignored

    const yaml = readFileSync(join(dataDir, 'livekit.yaml'), 'utf8');
    expect(yaml).toContain('use_external_ip: false');
    expect(yaml).not.toMatch(/dev|stun/i);
    expect(existsSync(join(dataDir, 'livekit.pid'))).toBe(true);

    await backend.stop();
    expect(backend.available).toBe(false);
    expect(existsSync(join(dataDir, 'livekit.pid'))).toBe(false);
  });

  it('LiveKit refuses a config with an unknown key (strict mode is on)', async () => {
    const dataDir = tempDir();
    const port = await freeLoopbackPort();
    const proc = new LivekitProcess({
      binaryPath: binary!,
      dataDir,
      logger: silentLogger,
      maxRestarts: 0,
      readyTimeoutMs: 15_000,
      prepare: async () => {
        const { writeFileSync } = await import('node:fs');
        const configPath = join(dataDir, 'bad.yaml');
        writeFileSync(configPath, `port: ${port}\nbind_addresses: ["127.0.0.1"]\nkeys: { GLkey12345: "${'s'.repeat(43)}" }\nnot_a_livekit_key: true\n`);
        return { configPath, port };
      },
    });
    cleanups.push(() => proc.stop());
    await expect(proc.start()).rejects.toThrow(/exited/);
    expect(proc.state).toBe('failed');
  });

  it('refuses unsigned webhooks on the internal webhook port', async () => {
    const dataDir = tempDir();
    const backend = new LivekitBackend({ binaryPath: binary!, dataDir, logger: silentLogger, nodeIp: '127.0.0.1', ...(await randomMediaPorts()) });
    cleanups.push(() => backend.stop());
    const events: VoiceWebhookEvent[] = [];
    await backend.start({ onReady: () => {}, onWebhook: (e) => events.push(e), onUnavailable: () => {} });
    const url = readFileSync(join(dataDir, 'livekit.yaml'), 'utf8').match(/"(http:\/\/127\.0\.0\.1:\d+\/livekit\/webhook)"/)![1]!;
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'ch_x' }, participant: { identity: 'u_0123456789abcdef0123456789abcdef' } });
    expect(await post(url, body)).toBe(401);
    expect(await post(url, body, { Authorization: 'Bearer nope' })).toBe(401);
    expect(events).toEqual([]);
  });
});
