import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Connection, ConnectionClosedError, MAX_INBOX, type ConnectionOptions } from '../src/ws/connection.js';

interface Pair {
  conn: Connection;
  client: WebSocket;
  received: unknown[];
  closed: Promise<{ code: number; reason: string }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A server-side Connection wired to a plain ws client over loopback HTTP. */
async function pair(opts: Partial<ConnectionOptions> = {}, clientOpts: WebSocket.ClientOptions = {}): Promise<Pair> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const connected = new Promise<Connection>((resolve) => {
    wss.once('connection', (ws) => {
      resolve(new Connection(ws, { ip: '127.0.0.1', ipKey: '127.0.0.1', pingIntervalMs: 60_000, pongTimeoutMs: 120_000, ...opts }));
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`, clientOpts);
  const received: unknown[] = [];
  client.on('message', (d) => received.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((r) => client.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise((r) => client.once('open', r));
  const conn = await connected;
  cleanups.push(async () => {
    client.terminate();
    wss.close();
    await new Promise((r) => http.close(r));
  });
  return { conn, client, received, closed };
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('Connection', () => {
  it('hands out envelopes one at a time, in arrival order', async () => {
    const { conn, client } = await pair();
    for (const t of ['a', 'b', 'c']) client.send(JSON.stringify({ t, id: 1 }));
    expect((await conn.nextEnvelope()).t).toBe('a');
    expect((await conn.nextEnvelope()).t).toBe('b');
    expect((await conn.nextEnvelope()).t).toBe('c');
    const pending = conn.nextEnvelope();
    client.send(JSON.stringify({ t: 'd', d: { x: 1 } }));
    expect(await pending).toEqual({ t: 'd', d: { x: 1 } });
  });

  it('refuses a second concurrent nextEnvelope()', async () => {
    const { conn } = await pair();
    void conn.nextEnvelope().catch(() => {});
    await expect(conn.nextEnvelope()).rejects.toThrow(/already pending/);
  });

  it.each([
    ['invalid JSON', '{nope', false],
    ['an envelope without t', JSON.stringify({ id: 1 }), false],
    ['a negative id', JSON.stringify({ t: 'x', id: -1 }), false],
    ['a binary frame', JSON.stringify({ t: 'x' }), true],
  ])('reports %s as ProtocolError(BAD_REQUEST) without closing', async (_label, frame, binary) => {
    const { conn, client } = await pair();
    client.send(binary ? Buffer.from(frame) : frame, { binary });
    await expect(conn.nextEnvelope()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(conn.closed).toBe(false);
    client.send(JSON.stringify({ t: 'ok' }));
    expect((await conn.nextEnvelope()).t).toBe('ok');
  });

  it('close() sends the error event, closes with 4000 + code and is idempotent', async () => {
    const { conn, received, closed } = await pair();
    const pending = conn.nextEnvelope();
    conn.close('PROTOCOL_UNSUPPORTED', { min: 1, max: 1 });
    conn.close('INTERNAL');
    conn.send({ t: 'late' });
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(await closed).toEqual({ code: 4000, reason: 'PROTOCOL_UNSUPPORTED' });
    expect(received).toEqual([{ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } }]);
    await expect(conn.nextEnvelope()).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('runs a deadline once, and clearDeadline/replacing cancels it', async () => {
    const { conn } = await pair();
    let fired = 0;
    conn.setDeadline(30, () => fired++);
    conn.clearDeadline();
    conn.setDeadline(30, () => (fired += 10));
    conn.setDeadline(60, () => (fired += 100));
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(100);
  });

  it(`closes with RATE_LIMITED when more than ${MAX_INBOX} frames pile up unread`, async () => {
    const { client, received, closed } = await pair();
    for (let i = 0; i <= MAX_INBOX; i++) client.send(JSON.stringify({ t: 'x', id: i }));
    expect((await closed).reason).toBe('RATE_LIMITED');
    expect(received).toEqual([{ t: 'error', d: { code: 'RATE_LIMITED' } }]);
  });

  it('terminates a peer that does not answer pings', async () => {
    const { closed } = await pair({ pingIntervalMs: 20, pongTimeoutMs: 100 }, { autoPong: false });
    expect((await closed).code).toBe(1006);
  });

  it('keeps a peer that answers pings', async () => {
    const { conn } = await pair({ pingIntervalMs: 100, pongTimeoutMs: 1_000 });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(conn.closed).toBe(false);
  });

  it('runs onClose listeners once, including ones added after the close', async () => {
    const { conn, client } = await pair();
    let calls = 0;
    conn.onClose(() => calls++);
    client.close();
    await waitFor(() => conn.socketClosed);
    let late = 0;
    conn.onClose(() => late++);
    await waitFor(() => late === 1);
    expect(calls).toBe(1);
    expect(conn.state).toBe('closed');
  });

});
