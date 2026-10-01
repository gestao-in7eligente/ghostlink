// Railway's GraphQL API and main's log as the Railway tests fake them (railwayProvisioner.test.ts,
// serverUpdates.test.ts). Nothing here ever reaches the real API.
import { formatWithOptions } from 'node:util';
import type { FetchInit, FetchResponse } from '../../src/main/railway/api.js';

type Reply = { data: unknown } | { errors: { message: string }[] } | { status: number; headers?: Record<string, string> } | Error | Promise<never>;
type Responder = Reply | ((variables: Record<string, unknown>) => Reply | Promise<Reply>);

/**
 * Railway's API as far as the app uses it: per operation, the replies given to the
 * latest on() in order (the last one repeats).
 */
export class FakeRailway {
  readonly calls: { op: string; variables: Record<string, unknown>; auth: string | undefined }[] = [];
  readonly #replies = new Map<string, Responder[]>();
  readonly #served = new Map<string, number>();

  on(op: string, ...replies: Responder[]): this {
    this.#replies.set(op, replies);
    this.#served.set(op, 0);
    return this;
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  variables(op: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.variables);
  }

  readonly fetch = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
    const body = JSON.parse(init.body) as { operationName: string; variables: Record<string, unknown> };
    const op = body.operationName;
    this.calls.push({ op, variables: body.variables, auth: init.headers.authorization });
    const replies = this.#replies.get(op);
    if (!replies) throw new Error(`unexpected ${op}`);
    const served = this.#served.get(op) ?? 0;
    this.#served.set(op, served + 1);
    const responder = replies[Math.min(served, replies.length - 1)]!;
    const reply = await (typeof responder === 'function' ? responder(body.variables) : responder);
    if (reply instanceof Error) throw reply;
    const status = 'status' in reply ? reply.status : 200;
    const headers = new Map(Object.entries('headers' in reply ? (reply.headers ?? {}) : {}));
    return { status, headers: { get: (n) => headers.get(n) ?? null }, text: async () => JSON.stringify('status' in reply ? {} : reply) };
  };
}

export const data = (d: unknown) => ({ data: d });
export const gqlError = (message: string) => ({ errors: [{ message }] });

/** A Log that keeps every line, formatted as main.log would. */
export function captureLog() {
  const lines: string[] = [];
  const write = (level: string) => (message: string, ...details: unknown[]) => void lines.push(`${level} ${formatWithOptions({ colors: false }, message, ...details)}`);
  return { lines, info: write('info'), warn: write('warn'), error: write('error') };
}
