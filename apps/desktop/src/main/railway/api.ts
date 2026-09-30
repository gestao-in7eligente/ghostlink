// Railway's public GraphQL API (research §1): POST with `Authorization: Bearer`, from the
// main process only — the API allows no browser origin but railway.com, and the token must
// never reach the renderer. The token lives in this object; every error message and log
// line is scrubbed of it.
import type { z } from 'zod';
import { AppError, type AppErrorCode } from '../../shared/appErrors.js';
import { mainLog, type Log } from '../log.js';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
export const REQUEST_TIMEOUT_MS = 20_000;
/** Attempts of a retryable call, 1 s then 2 s apart. */
export const REQUEST_ATTEMPTS = 3;
const BACKOFF_MS = 1_000;
/** A longer Retry-After (Free: 100 requests/hour) fails at once with RAILWAY_RATE_LIMITED. */
export const RETRY_AFTER_MAX_MS = 30_000;
const MESSAGES_MAX = 5;
const MESSAGE_MAX_LENGTH = 300;

export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'error';
  signal: AbortSignal;
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** fetch, or Electron's net.fetch in production (it follows the system proxy); a fake in tests. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/**
 * How a failed call may be repeated (research §1 "Retries"). A query always may. A mutation
 * never once Railway answered (an answer means it ran): 'idempotent' ones (same input, same
 * end state) are repeated only when no answer arrived at all, and creations never are.
 */
export type RetryPolicy = 'query' | 'idempotent' | 'never';

export interface Operation {
  /** The GraphQL operation name, also sent as `operationName`. */
  name: string;
  doc: string;
  retry: RetryPolicy;
}

/** A failed Railway call. `messages` are Railway's GraphQL error messages, kept in main. */
export class RailwayError extends AppError {
  constructor(
    code: AppErrorCode,
    message: string,
    readonly messages: readonly string[] = [],
  ) {
    super(code, message);
    this.name = 'RailwayError';
  }

  /** Railway said the object does not exist (e.g. a project deleted meanwhile). */
  get notFound(): boolean {
    return this.messages.some((m) => /not found/i.test(m));
  }
}

/** research §1: an auth failure is HTTP 200 with errors[0].message "Not Authorized". */
function isAuthMessage(message: string): boolean {
  return /not authori[sz]ed|unauthori[sz]ed|unauthenticated/i.test(message);
}

type Outcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'network'; detail: string }
  | { kind: 'rateLimited'; retryAfterMs: number | null }
  | { kind: 'server'; status: number; messages: string[] }
  | { kind: 'graphql'; status: number; messages: string[] }
  | { kind: 'http'; status: number };

/** Retry-After in seconds or as an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function retryDelay(policy: RetryPolicy, outcome: Outcome, attempt: number): number | null {
  const backoff = BACKOFF_MS * 2 ** (attempt - 1);
  switch (outcome.kind) {
    case 'network':
      return policy === 'never' ? null : backoff;
    case 'server':
      return policy === 'query' ? backoff : null;
    case 'rateLimited':
      return policy === 'query' && outcome.retryAfterMs !== null && outcome.retryAfterMs <= RETRY_AFTER_MAX_MS ? outcome.retryAfterMs : null;
    default:
      return null;
  }
}

function errorMessages(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MESSAGES_MAX).map((e) => {
    const message = (e as { message?: unknown } | null)?.message;
    return (typeof message === 'string' ? message : 'unknown error').slice(0, MESSAGE_MAX_LENGTH);
  });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Name and code of a fetch failure, e.g. "TypeError: fetch failed (ENOTFOUND)". */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return 'network error';
  const cause = (e as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `${e.name}: ${e.message.slice(0, MESSAGE_MAX_LENGTH)}${code}`;
}

export interface RailwayClientOptions {
  token: string;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  log?: Log;
}

export class RailwayClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #log: Log;

  constructor(opts: RailwayClientOptions) {
    this.#token = opts.token;
    this.#fetch = opts.fetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#log = opts.log ?? mainLog;
  }

  /**
   * Runs one operation and returns its `data`, checked against `schema`. Always inspects
   * `errors`, even on HTTP 200. Throws RailwayError with RAILWAY_TOKEN_INVALID ("Not
   * Authorized"), RAILWAY_RATE_LIMITED (429) or RAILWAY_API_ERROR (anything else).
   */
  async request<T>(op: Operation, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#send(op, variables);
      if (outcome.kind === 'ok') {
        const parsed = schema.safeParse(outcome.data);
        if (parsed.success) return parsed.data;
        this.#log.warn(`[railway] ${op.name}: unexpected response shape`);
        throw new RailwayError('RAILWAY_API_ERROR', `${op.name}: unexpected response shape`);
      }
      const delay = attempt < REQUEST_ATTEMPTS ? retryDelay(op.retry, outcome, attempt) : null;
      if (delay === null) throw this.#fail(op, outcome);
      this.#log.warn(`[railway] ${op.name}: ${this.#describe(outcome)}; attempt ${attempt + 1} in ${delay} ms`);
      await this.#sleep(delay);
    }
  }

  async #send(op: Operation, variables: Record<string, unknown>): Promise<Outcome> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ query: op.doc, variables, operationName: op.name }),
        // The Bearer token goes to this one URL only, never along a redirect.
        redirect: 'error',
        signal: abort.signal,
      });
      const text = await res.text();
      if (res.status === 429) return { kind: 'rateLimited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.#now()) };
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const messages = errorMessages(body);
      if (res.status >= 500) return { kind: 'server', status: res.status, messages };
      if (messages.length > 0) return { kind: 'graphql', status: res.status, messages };
      if (res.status < 200 || res.status >= 300 || !isRecord(body) || !isRecord(body.data)) return { kind: 'http', status: res.status };
      return { kind: 'ok', data: body.data };
    } catch (e) {
      return { kind: 'network', detail: abort.signal.aborted ? 'timed out' : this.#scrub(describeError(e)) };
    } finally {
      clearTimeout(timer);
    }
  }

  #fail(op: Operation, outcome: Exclude<Outcome, { kind: 'ok' }>): RailwayError {
    let code: AppErrorCode = 'RAILWAY_API_ERROR';
    let messages: string[] = [];
    if (outcome.kind === 'rateLimited') code = 'RAILWAY_RATE_LIMITED';
    else if (outcome.kind === 'graphql') {
      messages = outcome.messages.map((m) => this.#scrub(m));
      if (messages.some(isAuthMessage)) code = 'RAILWAY_TOKEN_INVALID';
    } else if (outcome.kind === 'server') messages = outcome.messages.map((m) => this.#scrub(m));
    else if (outcome.kind === 'http' && (outcome.status === 401 || outcome.status === 403)) code = 'RAILWAY_TOKEN_INVALID';
    const message = `${op.name}: ${this.#describe(outcome)}`;
    this.#log.warn(`[railway] ${message} → ${code}`);
    return new RailwayError(code, message, messages);
  }

  #describe(outcome: Exclude<Outcome, { kind: 'ok' }>): string {
    switch (outcome.kind) {
      case 'network':
        return outcome.detail;
      case 'rateLimited':
        return `HTTP 429 (Retry-After ${outcome.retryAfterMs === null ? 'none' : `${outcome.retryAfterMs} ms`})`;
      case 'http':
        return `HTTP ${outcome.status} without data`;
      default:
        return `HTTP ${outcome.status}: ${this.#scrub(outcome.messages.join('; ')) || 'no error message'}`;
    }
  }

  /** Belt and braces: the token never appears in a message that leaves this object. */
  #scrub(text: string): string {
    return this.#token === '' ? text : text.split(this.#token).join('[token]');
  }
}
