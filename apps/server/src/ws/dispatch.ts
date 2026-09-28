import { z } from 'zod';
import { ProtocolError, type Envelope, type ResErr, type ResOk } from '@ghostlink/shared';
import type { Logger } from '../logger.js';

export interface RequestContext {
  userId: string;
  sessionId: string;
  now: () => number;
}

export type RequestHandler = (ctx: RequestContext, payload: unknown) => unknown;

const pingSchema = z.strictObject({});

/** M1 handles only `ping` (spec §5.2): `{}` → `{ t: serverTime }`. */
export const M1_HANDLERS: Readonly<Record<string, RequestHandler>> = {
  ping: (ctx, payload) => {
    pingSchema.parse(payload ?? {});
    return { t: ctx.now() };
  },
};

export function errorResponse(id: number, code: ResErr['error']['code'], message: string = code): ResErr {
  return { t: 'res', id, ok: false, error: { code, message } };
}

/**
 * Maps a request envelope to its handler. Returns null for envelopes without an
 * id (nothing to answer). Unknown types and invalid payloads become BAD_REQUEST;
 * unexpected exceptions become INTERNAL and are logged without the payload.
 */
export function createDispatcher(handlers: Readonly<Record<string, RequestHandler>>, logger: Logger) {
  return async function dispatch(ctx: RequestContext, envelope: Envelope): Promise<ResOk | ResErr | null> {
    const { id } = envelope;
    if (id === undefined) return null;
    const handler = Object.hasOwn(handlers, envelope.t) ? handlers[envelope.t] : undefined;
    if (!handler) return errorResponse(id, 'BAD_REQUEST', 'unknown request type');
    try {
      const d = await handler(ctx, envelope.d);
      return { t: 'res', id, ok: true, d };
    } catch (e) {
      if (e instanceof ProtocolError) return errorResponse(id, e.code, e.message);
      if (e instanceof z.ZodError) return errorResponse(id, 'BAD_REQUEST', 'invalid payload');
      logger.error('request handler failed', { type: envelope.t, error: String(e) });
      return errorResponse(id, 'INTERNAL');
    }
  };
}
