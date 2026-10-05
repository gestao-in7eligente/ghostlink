import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import type { AppError } from '../../src/shared/appErrors.js';
import { probeServerKeyId } from '../../src/main/connection.js';
import { countingServer, deadPort, silentServer } from '../helpers/net.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(() => t.cleanup());

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError | ProtocolError).code;
  }
  throw new Error('expected a rejection');
}

describe('probeServerKeyId (TOFU, spec §3.3)', () => {
  it('reads the serverKeyId of a real server without a pin', async () => {
    expect(await probeServerKeyId(`127.0.0.1:${t.server.port}`)).toBe(t.server.serverKeyId);
  });

  it('reads the certificate and hangs up without sending a single HTTP byte', async () => {
    const decoy = await countingServer(t.dataDir);
    try {
      expect(await probeServerKeyId(`127.0.0.1:${decoy.port}`)).toBe(t.server.serverKeyId);
      await new Promise((r) => setTimeout(r, 100));
      expect(decoy.counts).toEqual({ connections: 1, requests: 0, upgrades: 0 });
    } finally {
      await decoy.close();
    }
  });

  it('reports UNREACHABLE for a closed port', async () => {
    expect(await codeOf(probeServerKeyId(`127.0.0.1:${await deadPort()}`))).toBe('UNREACHABLE');
  });

  it('gives up on a peer that never speaks TLS after timeoutMs', async () => {
    const hole = await silentServer();
    try {
      const started = Date.now();
      expect(await codeOf(probeServerKeyId(`127.0.0.1:${hole.port}`, { timeoutMs: 300 }))).toBe('UNREACHABLE');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await hole.close();
    }
  });

  it('rejects a malformed address with BAD_REQUEST before touching the network', async () => {
    const error = await probeServerKeyId('bad host:7700').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('BAD_REQUEST');
  });
});
