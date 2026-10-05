import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { OWNER_STATUS_LIMITS, OWNER_STATUS_PATH, type ErrorCode, type OwnerStatus } from '@ghostlink/shared';
import { writeFileAtomic } from '../config/paths.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SHARED_ADDRESS_KEY, SlidingWindowLimiter, ipKey } from '../ratelimit/limiter.js';
import { SERVER_VERSION } from '../version.js';
import type { VoiceModule } from '../voice/module.js';
import { ownerPublicKey, verifyOwnerStatusQuery } from './ownerStatus.js';

export const STATUS_MODULE = 'status';
/** In the data directory; read by install.sh --auto-update on a VPS (servers follow the app, §2 and §4). */
export const STATUS_FILE = 'status.json';

/** The content of status.json. */
export interface StatusFile extends OwnerStatus {
  /** When it was written (ISO 8601): the updater trusts `voiceActive` only while this is recent. */
  updatedAt: string;
}

export interface StatusModuleOptions {
  /** status.json is written again this often even when nothing changed. Default 60 s. */
  refreshMs?: number;
}

/** The `status` module plus what tests may read. */
export interface StatusModule extends ServerModule {
  readonly name: typeof STATUS_MODULE;
  /** What status.json and GET /owner/status say now. */
  current(): OwnerStatus;
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

function queryOf(url: string | undefined): string {
  const q = (url ?? '').indexOf('?');
  return q < 0 ? '' : (url ?? '').slice(q + 1);
}

/** An errno code (EACCES, ENOSPC…) and nothing else: fs messages carry paths. */
function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

const refuse = (res: ServerResponse, status: number, code: ErrorCode, headers?: Record<string, string>) => reply(res, status, { code }, headers);

/**
 * Whether anyone is in a call, for the two updaters (spec "servidores acompanham o app" §2):
 *   - `<dataDir>/status.json` (0640, written atomically) at start, whenever voice activity
 *     changes, and every 60 s, for install.sh --auto-update on a VPS;
 *   - GET /owner/status?ts=&sig=, signed by the current owner's key for this server, for the
 *     owner's app (Railway). 200 { version, voiceActive } or 403; 30 requests per minute per
 *     address. The URL is never logged.
 * Registered after `voice`, whose activity it reports (always false without it).
 */
export function createStatusModule(opts: StatusModuleOptions = {}): StatusModule {
  let ctx!: ModuleContext;
  let voice: VoiceModule | null = null;
  let limiter!: SlidingWindowLimiter;
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  /** The last write failed: the next failure is not logged again until one succeeds. */
  let failing = false;

  const current = (): OwnerStatus => ({ version: SERVER_VERSION, voiceActive: voice?.active ?? false });

  const write = (): void => {
    if (stopped) return;
    const content: StatusFile = { ...current(), updatedAt: new Date(ctx.now()).toISOString() };
    try {
      writeFileAtomic(join(ctx.dataDir, STATUS_FILE), `${JSON.stringify(content)}\n`, 0o640);
      failing = false;
    } catch (e) {
      if (!failing) ctx.logger.warn(`status: ${STATUS_FILE} could not be written`, { error: errnoOf(e) });
      failing = true;
    }
  };

  /** Behind a TCP proxy every client arrives from the proxy, so they share one key (spec §13). */
  const addressKey = (req: IncomingMessage): string => (ctx.options?.proxy ? SHARED_ADDRESS_KEY : ipKey(req.socket.remoteAddress ?? ''));

  const ownerStatus = (req: IncomingMessage, res: ServerResponse): void => {
    if (!limiter.hit(addressKey(req))) return refuse(res, 429, 'RATE_LIMITED', { 'Retry-After': '60' });
    if (req.method !== 'GET') return refuse(res, 405, 'BAD_REQUEST', { Allow: 'GET' });
    const allowed = verifyOwnerStatusQuery(queryOf(req.url), {
      serverKeyId: ctx.serverKeyId,
      nowMs: ctx.now(),
      ownerKey: ownerPublicKey(ctx.db),
    });
    // One answer for a bad signature, another member's, another server's, a stale or future
    // ts and a malformed query: nothing tells them apart.
    if (!allowed) return refuse(res, 403, 'FORBIDDEN');
    reply(res, 200, ownerAnswer());
  };

  /** The 200 answer of GET /owner/status. */
  const ownerAnswer = (): OwnerStatus => ({
    ...current(),
  });

  return {
    name: STATUS_MODULE,
    current,
    init(c) {
      ctx = c;
      stopped = false;
      try {
        voice = c.getModule<VoiceModule>('voice');
      } catch {
        voice = null; // no voice module: nobody can be in a call
      }
      limiter = new SlidingWindowLimiter(OWNER_STATUS_LIMITS.requestsPerMinute, 60_000, c.now);
    },
    start() {
      write();
      unsubscribe = voice?.onActiveChange(() => write()) ?? null;
      timer = setInterval(() => {
        write();
        limiter.sweep();
      }, opts.refreshMs ?? 60_000);
      timer.unref();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    http(req, res) {
      if (pathOf(req.url) !== OWNER_STATUS_PATH) return false;
      ownerStatus(req, res);
      return true;
    },
  };
}
