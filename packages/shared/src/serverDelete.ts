/**
 * Deleting a server (spec 2026-10-01-sair-e-excluir-servidor-design.md §3–§4): the owner's
 * `server.delete` takes the server offline at once for everyone else and erases it 48 h later;
 * until then `server.restore` brings it back. Payloads, events, the welcome field, strict
 * server schemas and lenient client schemas.
 *
 * Errors (packages/shared/src/errors.ts):
 *   - `SERVER_DELETING`: closes every session but the owner's at `server.delete`, and refuses
 *     everyone but the owner at the handshake while the deadline has not passed. The `error`
 *     event carries `at`, the deadline.
 *   - `SERVER_DELETED`: the deadline passed and the data is gone; everyone is refused, the
 *     owner included, and any session still open is closed with it.
 */
import { z } from 'zod';

/** The `features` flag of a server that answers `server.delete` and `server.restore` (spec §3: old servers have none). */
export const FEATURE_SERVER_DELETE = 'serverDelete';

export const SERVER_DELETE_LIMITS = {
  /** From `server.delete` to the erase. */
  graceMs: 48 * 60 * 60 * 1000,
  /** `server.delete` per owner per window, and `server.restore` the same, each on its own count (spec §4). */
  perWindow: 5,
  windowMs: 60 * 60 * 1000,
  /** How often the server checks whether the deadline passed (it also checks at start-up and at every handshake). */
  checkIntervalMs: 60 * 1000,
} as const;

/** `server.delete` request: no fields. Owner only. */
export type ServerDeletePayload = Record<string, never>;

/** `server.delete` response: the deadline (ms epoch, the server's clock). A repeated request keeps the first deadline. */
export interface ServerDeleteResult {
  at: number;
}

/** `server.restore` request: no fields. Owner only, before the deadline. */
export type ServerRestorePayload = Record<string, never>;

/** `server.restore` response: empty. Restoring a server that is not being deleted does nothing. */
export type ServerRestoreResult = Record<string, never>;

/** `server.deleting` event, to every session right before the non-owners are closed with SERVER_DELETING. */
export interface ServerDeletingEvent {
  /** The deadline, ms epoch. */
  at: number;
}

/** `server.restored` event, to every session (in practice the owner's): the deletion was cancelled. */
export type ServerRestoredEvent = Record<string, never>;

/** The welcome's `serverDelete` field: lets the owner's app show the restore banner after a reconnect. */
export interface ServerDeleteWelcome {
  /** The deadline while the server is being deleted, else null. */
  deletingAt: number | null;
}

const epochMs = z.number().int().nonnegative();

// ---- server side: strict (spec §5.1) ----

export const serverDeleteSchema = z.strictObject({});
export const serverRestoreSchema = z.strictObject({});

// ---- client side: z.object drops unknown keys ----

export const serverDeleteResultSchemaClient: z.ZodType<ServerDeleteResult> = z.object({ at: epochMs });

export const serverDeletingEventSchemaClient: z.ZodType<ServerDeletingEvent> = z.object({ at: epochMs });

export const serverRestoredEventSchemaClient = z.object({});

export const serverDeleteWelcomeSchemaClient: z.ZodType<ServerDeleteWelcome> = z.object({ deletingAt: epochMs.nullable() });
