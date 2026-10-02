import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

// ---- the few protobuf bits the relay touches (livekit_rtc.proto, protocol 1.50/1.51) ----
// SignalRequest.add_track = 4 → AddTrackRequest { type = 3, stereo = 12, audio_features = 17 }
// SignalResponse.answer = 2, .offer = 3 → SessionDescription { sdp = 2 }
// SignalResponse.trickle = 4 → TrickleRequest { candidateInit = 1 }
const ADD_TRACK = 4;
const TRACK_TYPE = 3;
const AUDIO = 0;
/** stereo = true (field 12, varint 1), audio_features = [TF_STEREO] (field 17, packed, enum 0). */
const STEREO_FIELDS = Uint8Array.of(0x60, 0x01, 0x8a, 0x01, 0x01, 0x00);
const ANSWER = 2;
const OFFER = 3;
const SDP = 2;
const TRICKLE = 4;
const CANDIDATE_INIT = 1;

interface Field {
  no: number;
  wire: number;
  /** The whole field as encoded (tag included). */
  raw: Uint8Array;
  /** Varint value (wire type 0). */
  varint?: number;
  /** Length-delimited payload (wire type 2). */
  payload?: Uint8Array;
}

function readVarint(buf: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const b = buf[i]!;
    value += (b & 0x7f) * scale;
    scale *= 128;
    if (b < 0x80) return [value, i + 1];
  }
  throw new Error('bad varint');
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

/** A message's fields in order; throws on anything malformed. */
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < buf.length) {
    const start = at;
    const [tag, next] = readVarint(buf, at);
    at = next;
    const field: Field = { no: Math.floor(tag / 8), wire: tag % 8, raw: buf };
    if (field.wire === 0) [field.varint, at] = readVarint(buf, at);
    else if (field.wire === 1) at += 8;
    else if (field.wire === 5) at += 4;
    else if (field.wire === 2) {
      const [len, body] = readVarint(buf, at);
      field.payload = buf.subarray(body, body + len);
      at = body + len;
    } else throw new Error('unsupported wire type');
    if (at > buf.length || field.no === 0) throw new Error('truncated');
    field.raw = buf.subarray(start, at);
    out.push(field);
  }
  return out;
}

function lengthField(no: number, payload: Uint8Array): Uint8Array {
  return Buffer.concat([Uint8Array.from([...varint(no * 8 + 2), ...varint(payload.length)]), payload]);
}

/** `msg` with the string field `no` passed through `edit` (the other fields unchanged); null when nothing changed. */
function editString(msg: Uint8Array, no: number, edit: (s: string) => string): Uint8Array | null {
  let changed = false;
  const parts = fields(msg).map((f) => {
    if (f.no !== no || f.wire !== 2) return f.raw;
    const before = Buffer.from(f.payload!).toString('utf8');
    const after = edit(before);
    if (after === before) return f.raw;
    changed = true;
    return lengthField(no, Buffer.from(after, 'utf8'));
  });
  return changed ? Buffer.concat(parts) : null;
}

/**
 * The DJ's audio AddTrackRequest, marked stereo: what livekit-client sends for `stereo: true`.
 * @livekit/rtc-node cannot (its AddTrackRequest never sets it), so LiveKit answers without
 * `stereo=1` and libwebrtc encodes in mono and in Opus's voice mode, whose high-pass filter
 * takes the deep bass. Any other message is returned as it came.
 */
export function markStereo(data: Uint8Array): Uint8Array {
  try {
    const top = fields(data);
    if (top.length !== 1 || top[0]!.no !== ADD_TRACK || top[0]!.wire !== 2) return data;
    const track = top[0]!.payload!;
    const type = fields(track).findLast((f) => f.no === TRACK_TYPE && f.wire === 0)?.varint ?? AUDIO;
    if (type !== AUDIO) return data;
    return lengthField(ADD_TRACK, Buffer.concat([track, STEREO_FIELDS]));
  } catch {
    return data;
  }
}

/**
 * The loopback twin of an ICE candidate (an SDP `a=candidate:` line or a bare `candidate:`) on
 * LiveKit's ICE-TCP port: the same candidate at 127.0.0.1, ranked one above it. Null for any
 * other line.
 */
export function loopbackTwin(line: string, port: number): string | null {
  const m = /^((?:a=)?candidate:)(\S+) (\d+) tcp (\d+) (\S+) (\d+)( typ host\b[^\r\n]*)(\r?)$/i.exec(line);
  if (!m || Number(m[6]) !== port || m[5] === '127.0.0.1' || Number(m[4]) >= 2 ** 31 - 1) return null;
  return `${m[1]}${m[2]}0 ${m[3]} tcp ${Number(m[4]) + 1} 127.0.0.1 ${m[6]}${m[7]}${m[8]}`;
}

/**
 * Behind a TCP proxy LiveKit announces one address, the proxy's: the DJ, which runs next to
 * LiveKit, would send its sound out to the proxy and back in through the server's public port
 * (and its event loop). Each LiveKit candidate on the ICE-TCP port (`port`) in a SignalResponse
 * (an answer or offer, a trickled candidate) gets a loopback twin ranked above it, so the DJ
 * reaches LiveKit inside the machine; where the system will not connect to loopback from the
 * DJ's sockets (Windows), the original candidate still works. Returns the messages to forward:
 * the original first.
 */
export function loopbackIce(data: Uint8Array, port: number): Uint8Array[] {
  try {
    const top = fields(data);
    if (top.length !== 1 || top[0]!.wire !== 2) return [data];
    const { no, payload } = top[0]!;
    if (no === ANSWER || no === OFFER) {
      const edited = editString(payload!, SDP, (sdp) =>
        sdp
          .split('\n')
          .flatMap((l) => {
            const twin = loopbackTwin(l, port);
            return twin ? [l, twin] : [l];
          })
          .join('\n'),
      );
      return [edited ? lengthField(no, edited) : data];
    }
    if (no === TRICKLE) {
      const twin = editString(payload!, CANDIDATE_INIT, (json) => {
        const init = JSON.parse(json) as { candidate?: unknown };
        const candidate = typeof init.candidate === 'string' ? loopbackTwin(init.candidate, port) : null;
        return candidate ? JSON.stringify({ ...init, candidate }) : json;
      });
      return twin ? [data, lengthField(no, twin)] : [data];
    }
    return [data];
  } catch {
    return [data];
  }
}

export interface SignalRelay {
  /** ws://127.0.0.1:<port>: what the DJ's Room connects to instead of LiveKit. */
  readonly url: string;
  /** How many messages it changed (tests). */
  readonly changed: { stereo: number; candidates: number };
  close(): Promise<void>;
}

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

const closeCode = (code: number): number => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

/**
 * A loopback WebSocket relay between the DJ (@livekit/rtc-node) and the server's own LiveKit
 * signaling port, for the DJ's connection only. It marks the DJ's audio track stereo and, behind a
 * TCP proxy (`icePort`: LiveKit's ICE-TCP port), points LiveKit's candidates at 127.0.0.1 so the
 * DJ's sound stays inside the machine. Everything else passes byte for byte; media never goes
 * through it.
 */
export async function startSignalRelay(o: { target: string; icePort: number | null }): Promise<SignalRelay> {
  const target = new URL(o.target);
  const changed = { stereo: 0, candidates: 0 };
  const sockets = new Set<WebSocket>();
  const raw = new Set<Duplex>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  const server: Server = createServer((req, res) => {
    // rtc-node asks /rtc/validate when a join fails: forwarded as is.
    const up = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers, timeout: 15_000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.end();
    });
    req.pipe(up);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    raw.add(socket);
    socket.once('close', () => raw.delete(socket));
    socket.on('error', () => socket.destroy());
    const headers: Record<string, string> = {};
    if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
    const upstream = new WebSocket(`ws://${target.host}${req.url ?? '/'}`, { headers, perMessageDeflate: false, handshakeTimeout: 15_000 });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    // LiveKit refused the join (a bad token, a full room): the DJ gets the same answer.
    upstream.once('unexpected-response', (_r, res) => {
      let answer = `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2) answer += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
      socket.write(`${answer}\r\n`);
      res.pipe(socket);
      res.on('error', () => socket.destroy());
    });
    upstream.once('error', () => socket.destroy());
    // The DJ gave up before LiveKit answered: so does the relay.
    socket.once('close', () => {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
    upstream.once('open', () => {
      if (socket.destroyed) return void upstream.terminate();
      wss.handleUpgrade(req, socket, head, (client) => {
        sockets.add(client);
        client.once('close', () => sockets.delete(client));
        client.on('message', (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return;
          if (!isBinary) return upstream.send(data, { binary: false });
          const before = bytes(data);
          const after = markStereo(before);
          if (after !== before) changed.stereo++;
          upstream.send(after, { binary: true });
        });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (!isBinary || o.icePort === null) return client.send(data, { binary: isBinary });
          const before = bytes(data);
          const out = loopbackIce(before, o.icePort);
          if (out.length > 1 || out[0] !== before) changed.candidates++;
          for (const m of out) client.send(m, { binary: true });
        });
        client.on('close', (code, reason) => upstream.close(closeCode(code), reason));
        upstream.on('close', (code, reason) => client.close(closeCode(code), reason));
        client.on('error', () => client.terminate());
        upstream.on('error', () => upstream.terminate());
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    changed,
    async close() {
      for (const s of sockets) s.terminate();
      for (const s of raw) (s as Socket).destroy();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
