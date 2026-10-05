import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProtocolError, uploadBeginSchema, type ErrorCode, type UploadBegin, type UploadBeginResult, type UploadPurpose } from '@ghostlink/shared';
import type { Logger } from '../logger.js';
import type { RequestContext } from '../modules.js';
import { errnoOf, fail, preflight, queryOf, receiveBody, refuseUpload, reply, type ReceivedBody } from './http.js';
import { MAX_OPEN_UPLOADS_PER_SESSION, UploadTokens, type AttachmentGrant, type UploadGrant } from './tokens.js';

/** How a purpose answers its POST /upload: 200 with a body, or a refusal sent as `{ code }`. */
export type UploadAnswer = { ok: true; body: object } | { ok: false; code: ErrorCode };

/**
 * One kind of upload (avatar, icon, attachment). The hub does what every
 * purpose shares: the strict schema, the token, the size cut, the hash and the temp file.
 */
export interface UploadPurposeHandler {
  /** Where the body is written first; it must be on the same disk as the file's final place. */
  readonly stagingDir: string;
  /** The most bytes this purpose ever takes (the token's `size` is checked against it too). */
  readonly maxBytes: () => number;
  /**
   * upload.begin, after the schema and the open-token check: permissions, limits and the
   * purpose's own rate limit (ProtocolError). Returns what the token carries and adds to the answer.
   */
  begin(ctx: RequestContext, payload: UploadBegin): { attachment?: AttachmentGrant; botId?: string; answer?: Omit<UploadBeginResult, 'uploadToken'> };
  /** True while the grant may still be used (checked before the body and again before finish). Synchronous. */
  canApply(grant: UploadGrant): boolean;
  /**
   * The body arrived whole, with the declared size and hash. The handler owns `body.staged`
   * from here: it moves it into place or deletes it. A throw deletes it and answers INTERNAL.
   */
  finish(grant: UploadGrant, body: ReceivedBody): UploadAnswer | Promise<UploadAnswer>;
}

export interface UploadHubOptions {
  now(): number;
  logger: Logger;
  /** See SessionsApi.fileToken: non-null only for a current session. */
  fileToken(sessionId: string): string | null;
  /** An upload is cut after this long without a byte. */
  idleMs: number;
}

/** fileInfo and imageInfo read only the start of a file. */
const HEAD_BYTES = 1024 * 1024;

/**
 * `upload.begin` + `POST /upload?u=<uploadToken>` for every purpose (main spec §4, §7): the
 * token is single use, lives 60 s and is bound to its session; at most 3 are open per session;
 * the body is cut as soon as it passes the declared size and must match the declared SHA-256.
 * Register a purpose once, in a module's init. URLs, tokens and bytes never reach the log.
 */
export class UploadHub {
  readonly tokens: UploadTokens;
  readonly #purposes = new Map<UploadPurpose, UploadPurposeHandler>();

  constructor(private readonly opts: UploadHubOptions) {
    this.tokens = new UploadTokens(opts.now);
  }

  register(purpose: UploadPurpose, handler: UploadPurposeHandler): void {
    if (this.#purposes.has(purpose)) throw new Error(`upload purpose ${purpose} registered twice`);
    this.#purposes.set(purpose, handler);
  }

  /** The `upload.begin` handler. A purpose no module registered is BAD_REQUEST, like an unknown one. */
  begin(ctx: RequestContext, payload: unknown): UploadBeginResult {
    const p = uploadBeginSchema.parse(payload);
    const handler = this.#purposes.get(p.purpose);
    if (!handler) throw new ProtocolError('BAD_REQUEST', 'unknown upload purpose');
    if (this.tokens.open(ctx.sessionId) >= MAX_OPEN_UPLOADS_PER_SESSION) throw new ProtocolError('RATE_LIMITED');
    const extra = handler.begin(ctx, p);
    const uploadToken = this.tokens.issue({
      purpose: p.purpose,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      size: p.size,
      sha256: p.sha256,
      ...(extra.attachment ? { attachment: extra.attachment } : {}),
      ...(extra.botId ? { botId: extra.botId } : {}),
    });
    return { uploadToken, ...extra.answer };
  }

  #usable(grant: UploadGrant | null): { grant: UploadGrant; handler: UploadPurposeHandler } | null {
    if (!grant || this.opts.fileToken(grant.sessionId) === null) return null;
    const handler = this.#purposes.get(grant.purpose);
    return handler?.canApply(grant) ? { grant, handler } : null;
  }

  /** `POST /upload?u=<uploadToken>`: 200 with the purpose's answer, else `{ code }`. */
  serve(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'OPTIONS') return preflight(res, 'POST, OPTIONS');
    if (req.method !== 'POST') return reply(res, 405, null, { Allow: 'POST, OPTIONS' });
    const tokens = new URLSearchParams(queryOf(req.url)).getAll('u');
    const usable = this.#usable(tokens.length === 1 ? this.tokens.take(tokens[0]!) : null);
    if (!usable) return refuseUpload(req, res, 'FORBIDDEN');
    const { grant, handler } = usable;
    const declared = req.headers['content-length'];
    if (grant.size > handler.maxBytes() || (declared !== undefined && Number(declared) > grant.size)) return refuseUpload(req, res, 'BAD_REQUEST');
    // Limits that changed since upload.begin are the purpose's to check in finish: the body
    // (no bigger than what upload.begin accepted) is read first, so the client gets the answer
    // instead of a reset connection.
    receiveBody(req, { dir: handler.stagingDir, limit: grant.size, idleMs: this.opts.idleMs, headBytes: HEAD_BYTES }, (body) => {
      if (!body.ok) {
        if (body.reason === 'too-large') return refuseUpload(req, res, 'BAD_REQUEST');
        if (body.reason === 'error') {
          this.opts.logger.error('an upload could not be written', { purpose: grant.purpose, error: errnoOf(body.error) });
          return refuseUpload(req, res, 'INTERNAL');
        }
        return; // aborted: nobody to answer
      }
      if (body.size !== grant.size || body.sha256 !== grant.sha256) {
        discardStaged(body.staged);
        return fail(res, 'BAD_REQUEST');
      }
      this.#finish(handler, grant, body, res);
    });
  }

  #finish(handler: UploadPurposeHandler, grant: UploadGrant, body: ReceivedBody, res: ServerResponse): void {
    const onError = (e: unknown) => {
      discardStaged(body.staged);
      this.opts.logger.error('an upload could not be stored', { purpose: grant.purpose, error: errnoOf(e) });
      fail(res, 'INTERNAL');
    };
    let answer: UploadAnswer | Promise<UploadAnswer>;
    try {
      answer = handler.finish(grant, body);
    } catch (e) {
      return onError(e);
    }
    Promise.resolve(answer).then((a) => (a.ok ? reply(res, 200, a.body) : fail(res, a.code)), onError);
  }
}

/** Deletes a temp file nobody took; harmless once it was moved into place. */
export function discardStaged(staged: string): void {
  try {
    rmSync(staged, { force: true });
  } catch {
    // The store's start-up clean-up removes leftovers.
  }
}
