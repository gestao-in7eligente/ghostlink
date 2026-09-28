import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TrackSource, WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import type { Logger } from '../logger.js';

export type TrackKind = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio' | 'unknown';

/** A LiveKit webhook reduced to what the voice module uses (no protobuf types leak out). */
export interface VoiceWebhookEvent {
  event: string;
  room: string | null;
  identity: string | null;
  participantSid: string | null;
  track: { sid: string; source: TrackKind } | null;
}

export function trackKind(source: TrackSource | undefined): TrackKind {
  switch (source) {
    case TrackSource.MICROPHONE:
      return 'microphone';
    case TrackSource.CAMERA:
      return 'camera';
    case TrackSource.SCREEN_SHARE:
      return 'screen_share';
    case TrackSource.SCREEN_SHARE_AUDIO:
      return 'screen_share_audio';
    default:
      return 'unknown';
  }
}

export function toVoiceWebhookEvent(e: WebhookEvent): VoiceWebhookEvent {
  return {
    event: e.event,
    room: e.room?.name || null,
    identity: e.participant?.identity || null,
    participantSid: e.participant?.sid || null,
    track: e.track ? { sid: e.track.sid, source: trackKind(e.track.source) } : null,
  };
}

const PATH = '/livekit/webhook';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * LiveKit's webhook receiver on 127.0.0.1:<free port> (spec §8.1, §8.3). Every POST is
 * authenticated with WebhookReceiver (JWT signed with our apiSecret + SHA-256 of the
 * body); anything else is refused. Bodies are never logged.
 */
export class WebhookServer {
  readonly #receiver: WebhookReceiver;
  readonly #logger: Logger;
  readonly #onEvent: (e: VoiceWebhookEvent) => void;
  readonly #server: Server;

  constructor(opts: { apiKey: string; apiSecret: string; logger: Logger; onEvent(e: VoiceWebhookEvent): void }) {
    this.#receiver = new WebhookReceiver(opts.apiKey, opts.apiSecret);
    this.#logger = opts.logger;
    this.#onEvent = opts.onEvent;
    this.#server = createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, (req, res) => {
      if (req.method !== 'POST' || req.url !== PATH) {
        res.writeHead(404, { 'Content-Length': 0 }).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooBig = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString('utf8');
        this.#receiver.receive(body, req.headers.authorization).then(
          (event) => {
            res.writeHead(200, { 'Content-Length': 0 }).end();
            try {
              this.#onEvent(toVoiceWebhookEvent(event));
            } catch (e) {
              this.#logger.error('voice webhook handler failed', { error: String(e) });
            }
          },
          () => {
            this.#logger.warn('refused a LiveKit webhook with an invalid signature');
            res.writeHead(401, { 'Content-Length': 0 }).end();
          },
        );
      });
      req.on('error', () => {});
    });
  }

  /** Listens on 127.0.0.1 and a free port; returns the webhook URL. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}${PATH}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#server.listening) return resolve();
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}
