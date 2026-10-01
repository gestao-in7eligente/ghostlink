# Server modules

Each feature track (Text/roles, Voice, Hosting) plugs into the server as a `ServerModule` (`src/modules.ts`). Put your code in its own files, and don't edit the gateway, dispatcher or HTTP server.

## Adding a module

1. Create `src/<feature>/` with a factory such as `createTextModule(): ServerModule`. The `name` must be unique.
2. Register it with one line in `src/defaultModules.ts`, which the CLI `start` command and the desktop Hosting mode both use. List modules after the ones they call through `ctx.getModule()`. In tests, pass it explicitly: `startTestServer({ modules: [createTextModule()] })`.
3. Lifecycle:
   - `init(ctx)` runs before listen, after the migrations. Keep `ctx`, which holds `db`, `now`, `logger`, `limits`, `dataDir`, `serverKeyId`, `sessions`, `options` (feature options from `startServer`, e.g. `voice`) and `getModule`.
   - `start({ port })` runs after listen.
   - `stop()` runs in reverse order on close, after every session has ended and before the DB closes.
   - If `init` or `start` throws, startup is aborted and every module whose `init` succeeded is stopped. A module whose `init` threw must clean up after itself.
4. `handlers`: request type → `(ctx, payload) => response`.
   - Validate the payload with a `z.strictObject` schema. A `ZodError` becomes `BAD_REQUEST`.
   - Throw `ProtocolError(code)` for protocol errors. Anything else becomes `INTERNAL`.
   - Name types after spec §5.2 (`msg.send`, `voice.join`, …). If two modules register the same type, startup fails.
   - After every `await`, check `ctx.isCurrent()` before any side effect (spec §5.1).
   - Per-action rate limits (spec §13) belong to your module. Use `SlidingWindowLimiter`.
5. `welcome(session)` returns extra welcome keys for that session. For example, Text adds `channels`, `roles`, `members` and `readStates`, and Voice adds `voice`.
   - It must be synchronous and must not send events.
   - A key that clashes with an M1 key or with another module's key closes the session with `INTERNAL`.
   - Feature flags go in `features`, which is read at every welcome (a getter may turn one on later, as voice does once LiveKit runs).
6. `http(req, res)` and `upgrade(req, socket, head)` return `true` when they handled the request. Built-in routes and `/ws` always win. Don't log URLs, because `/rtc` query strings carry tokens.
7. `iceTcpPort()` matters only behind a TCP proxy (spec §8.6), where the public port also carries ICE-TCP. It returns the `127.0.0.1` port those connections are piped to, or `null` while there is none. Voice returns LiveKit's `rtc.tcp_port` while LiveKit runs. It is called once per connection, so keep it cheap.

## Protocol types

Put a feature's payload and event types, its server-side strict schemas and its client-side lenient schemas (`z.object`) in `packages/shared/src/<feature>.ts`. Add one `export * from './<feature>.js';` line to `packages/shared/src/index.ts`. Permission checks always go through `permissionsFor()` in `packages/shared/src/permissions.ts`, and bit positions never change.

## Sessions, audience and presence

- `ctx.sessions.broadcast(event, filter)` calls `filter` once per recipient. **Audience rule (spec §5.3):**
  - Every channel-scoped event (message, reaction, typing, `voice.state`, read state, channel create/update) must pass a filter that checks `has(permissionsFor(member, channel), VIEW_CHANNEL)` for that recipient, computed at send time.
  - Never broadcast a channel event without a filter.
  - Answer a hidden channel with `NOT_FOUND`, the same as a missing one.
  - Only membership and presence events go to everyone.
- `onSessionClosed(session, { reason, graceExpired })`:
  - `graceExpired: false` fires once when each session ends.
  - `graceExpired: true` fires once when the user goes offline: either `LIMITS.presenceGraceMs` after the last session ends without a reconnect, or immediately after `sessions.closeUser()`.
  - It never fires for `SESSION_REPLACED` or at shutdown.
- Presence pattern:
  - Keep an `online` set.
  - On `onSessionOpened`, if the user isn't in the set, add them and broadcast `presence { online: true }`.
  - On `graceExpired: true`, remove them and broadcast `presence { online: false }`.
  - Voice uses the same `graceExpired: true` signal to call `removeParticipant`, and `isOnlineOrInGrace()` for the `/rtc` proxy check.
- To kick or ban, call `sessions.closeUser(userId, 'KICKED' | 'BANNED')`. The session disappears at once, with no grace, and the hooks run before the call returns. An optional third argument adds fields to the `error` event (`{ at }` with `SERVER_DELETING`).

## Migrations

Migrations are numbered SQL files in `src/db/migrations/NNN_name.sql`, one transaction each. `loadMigrations()` refuses gaps.

- The Text track owns `002_*.sql`; `003_server_delete.sql` adds `server_meta.deleting_at` and `deleted_at` (the `serverDelete` module, `src/deletion/`).
- Any other track that needs tables takes the next free number when it merges, and renumbers its file if another track merged first, so the numbering stays contiguous.
- Never edit a migration that has already been merged. Use `STRICT` tables, as `001_init.sql` does.

## Tests

Put tests next to the existing ones in `apps/server/test` (and `test/integration`). In a test client, `client.rawWelcome` shows module welcome keys, which the client schema strips. To make grace timers fast, use `limits: { presenceGraceMs: 50 }`.

## Deleting the server

`src/deletion/` (spec 2026-10-01-sair-e-excluir-servidor-design.md): while `server_meta.deleting_at` is set, the handshake and admission refuse everyone but the owner with `SERVER_DELETING`; once the deadline passed, everyone with `SERVER_DELETED`. The `serverDelete` module (registered last) answers `server.delete` / `server.restore` and, at the deadline, closes every session and erases the data in place (`erase.ts`). A table added by a later migration is emptied too, without changes; a module that keeps member data in its own files must add them to `eraseFiles()`.
