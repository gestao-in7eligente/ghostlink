import { request } from 'node:https';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@ghostlink/shared';
import { SERVER_VERSION } from '../../src/index.js';
import { connectRaw, startTestServer, type TestServer } from '../helpers/testClient.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer({ name: 'Casa do Zé' });
});
afterAll(() => t.cleanup());

function http(method: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: t.server.port, method, path, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTPS routes (spec §4)', () => {
  it('GET /health returns only public facts', async () => {
    const res = await http('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({ ok: true, name: 'Casa do Zé', version: SERVER_VERSION, protocol: { min: PROTOCOL.min, max: PROTOCOL.max } });
  });

  it('GET /health ignores the query string', async () => {
    expect((await http('GET', '/health?x=1')).status).toBe(200);
  });

  it('HEAD / and GET / answer 200 with CORS * (livekit-client reconnect probe)', async () => {
    const head = await http('HEAD', '/');
    expect(head.status).toBe(200);
    expect(head.headers['access-control-allow-origin']).toBe('*');
    expect(head.body).toBe('');
    const get = await http('GET', '/');
    expect(get.status).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBe('*');
    expect(get.body).toBe('OK');
  });

  it.each([
    ['GET', '/nope'],
    ['GET', '/files/abc'],
    ['POST', '/'],
    ['POST', '/health'],
    ['DELETE', '/health'],
    ['GET', '/ws'], // plain GET without the upgrade handshake
    ['GET', '/../etc/passwd'],
  ])('%s %s → 404 with no body', async (method, path) => {
    const res = await http(method, path);
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses WebSocket upgrades outside /ws', async () => {
    await expect(connectRaw(t.server, { path: '/other' })).rejects.toThrow();
  });

  it('accepts the /ws upgrade and speaks TLS 1.3 with the pinned key', async () => {
    const raw = await connectRaw(t.server);
    expect(raw.ws.readyState).toBe(raw.ws.OPEN);
    raw.close();
    const socket = connect({ host: '127.0.0.1', port: t.server.port, rejectUnauthorized: false });
    await new Promise<void>((r) => socket.once('secureConnect', () => r()));
    expect(socket.getProtocol()).toBe('TLSv1.3');
    socket.destroy();
  });

  it('a client pinned to another key never reaches the upgrade', async () => {
    await expect(connectRaw(t.server, { pin: 'A'.repeat(43) })).rejects.toMatchObject({ code: 'PIN_MISMATCH' });
  });
});
