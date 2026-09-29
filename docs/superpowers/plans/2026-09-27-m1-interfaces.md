# Milestone 1 — Interface contract

This document pins the **names, signatures, file paths and versions** shared by the three Milestone 1 plans:

- `2026-09-27-m1a-shared-server.md`
- `2026-09-27-m1b-desktop.md`
- `2026-09-27-m1c-ci-packaging.md`

When a plan and this file disagree, this file wins. Spec: `docs/superpowers/specs/2026-09-27-ghostlink-design.md`.

Code, identifiers, comments and commit messages are in English. User-facing strings live in the i18n files (pt-BR + en).

## 0. Environment facts (Windows dev machine)

- System Node is **24.14.0**. On it `node:sqlite` prints an ExperimentalWarning.
  - Every script that runs Node on server code passes `--disable-warning=ExperimentalWarning`.
  - Vitest uses `NODE_OPTIONS=--disable-warning=ExperimentalWarning`, set in the root `test` script via `cross-env`.
- The shell used by agents runs inside VS Code, which exports **`ELECTRON_RUN_AS_NODE=1`**. Any script that launches Electron must unset it first:
  - `scripts/run-electron.mjs` deletes it from `env` before spawning.
  - In Playwright, pass `env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }`.
- The network is flaky. Use `npm install --fetch-retries=6 --fetch-retry-mintimeout=5000`.
- `livekit-server.exe` is **not** needed in M1.

## 1. Pinned versions (exact, no ranges)

| Package | Version | Where |
|---|---|---|
| typescript | 6.0.3 | root dev (typescript-eslint supports `<6.1`; TS 7 is not supported) |
| vitest | 5.0.2 | root dev |
| vite | 7.3.6 | root dev (electron-vite 5 needs vite ≤7; vitest 5 accepts 7) |
| @types/node | latest 24.x (`npm view @types/node@24 version`) | root dev |
| cross-env | latest | root dev |
| eslint | 10.11.0 | root dev |
| typescript-eslint | 8.70.1 | root dev |
| zod | 4.6.5 | shared dep |
| ws | 8.22.0 | server + desktop dep |
| @types/ws | 8.18.1 | dev |
| @peculiar/x509 | 2.1.0 | server dep |
| reflect-metadata | 0.2.2 | server dep |
| tsx | 4.23.15 | server dev |
| esbuild | 0.28.2 | server dev (bundles the VPS CLI) |
| electron | 44.4.5 | desktop dev |
| electron-vite | 5.0.0 | desktop dev |
| @vitejs/plugin-react | 5.2.0 | desktop dev |
| react / react-dom | 19.3.0 | desktop dep |
| @types/react / @types/react-dom | 19.3.0 | desktop dev |
| zustand | 5.0.15 | desktop dep |
| electron-builder | 26.15.3 | desktop dev |

**Zod 4 notes.** Use `z.strictObject({...})` for server-side input. Use `z.object({...})` for client-side parsing, which strips unknown keys. Error formatting uses `z.prettifyError` or `error.issues`.

## 2. Repository layout (M1 subset)

```
package.json                  # name "ghostlink", private, "type":"module", workspaces ["packages/*","apps/*"], engines.node ">=24.14"
tsconfig.base.json            # strict, target ES2023, module/moduleResolution "NodeNext", verbatimModuleSyntax, noUncheckedIndexedAccess
vitest.config.ts              # test.projects: ["packages/shared", "apps/server", "apps/desktop"]
eslint.config.js              # flat config, typescript-eslint recommended
.gitignore  .gitattributes (* text=auto eol=lf)  LICENSE (GPL-3.0 full text)  README.md
packages/shared/  package.json ("name":"@ghostlink/shared","exports":{".":"./src/index.ts"}) tsconfig.json vitest.config.ts src/ test/
apps/server/      package.json ("name":"@ghostlink/server","exports":{".":"./src/index.ts"},"bin":{"ghostlink-server":"./dist/cli.js"}) tsconfig.json vitest.config.ts src/ test/ scripts/build.mjs
apps/desktop/     package.json ("name":"@ghostlink/desktop","main":"./out/main/index.js") electron.vite.config.ts tsconfig*.json electron-builder.yml build/ src/ test/
.github/workflows/ci.yml
```

- Workspace packages export **TypeScript source**. Every consumer (vitest, tsx, electron-vite, esbuild) compiles it.
- Relative imports inside packages use the `.js` extension (NodeNext), e.g. `import { x } from './invite.js'`.
- Cross-package imports use the package name: `import { parseInvite } from '@ghostlink/shared'`.

## 3. `@ghostlink/shared` public API (`packages/shared/src/index.ts` re-exports all)

### `constants.ts`
```ts
export const APP_NAME = 'GhostLink';
export const APP_ID = 'app.ghostlink.desktop';
export const DEFAULT_PORT = 7700;
export const PROTOCOL = { min: 1, max: 1, current: 1 } as const;
export const CRYPTO_LABELS = {
  identitySalt: 'ghostlink/identity/v1',
  authPrefix: 'ghostlink-auth-v1',
  fileHmac: 'ghostlink-file-v1',
  keyFileMagic: 'GLKEY',
  pastePrefix: 'GL1-',
  scheme: 'ghostlink',
} as const; // FROZEN — never change (spec §3.6)
export const LIMITS = {
  maxPayloadBytes: 256 * 1024,
  helloTimeoutMs: 5_000,
  proofTimeoutMs: 10_000,
  challengeTtlMs: 30_000,
  pingIntervalMs: 15_000,
  pongTimeoutMs: 30_000,
  presenceGraceMs: 20_000,
  maxUnauthenticatedConnections: 256,
  maxConnectionsPerIp: 20,
  authFailuresPerIpPerMinute: 10,
  pendingChallengesPerIp: 5,
  newIdentitiesPerIpPerHour: 5,
  requestsPerSecondPerSession: 30,
  nicknameMaxVisible: 32,
  inviteMaxAddresses: 8,
  inviteMaxLength: 2048,
} as const;
```

### `errors.ts`
```ts
export const ERROR_CODES = [
  'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'HIERARCHY', 'RATE_LIMITED', 'INTERNAL',
  'PROTOCOL_UNSUPPORTED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID', 'BAD_SIGNATURE',
  'CHALLENGE_EXPIRED', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'BAD_SETUP_CODE',
  'SESSION_REPLACED', 'KICKED', 'SERVER_SHUTDOWN',
  'CHANNEL_FULL', 'FILE_TOO_LARGE', 'IMAGE_TOO_LARGE', 'QUOTA_EXCEEDED', 'BAD_ATTACHMENT', 'OWNER_MUST_TRANSFER',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode, message?: string, public readonly extra?: Record<string, unknown>);
}
export function isErrorCode(x: unknown): x is ErrorCode;
```

### `encoding.ts` (pure JS, no Buffer)
```ts
export function toBase64Url(bytes: Uint8Array): string;
export function fromBase64Url(s: string): Uint8Array; // throws ProtocolError('BAD_REQUEST') on invalid input
export function toBase32(bytes: Uint8Array): string;  // RFC 4648 alphabet, no padding
export function utf8(s: string): Uint8Array;
```

### `protocol.ts` (envelope + M1 message types)
```ts
export type Envelope = { t: string; id?: number; d?: unknown };
export type ResOk<T = unknown> = { t: 'res'; id: number; ok: true; d: T };
export type ResErr = { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } };
export type ServerErrorEvent = { t: 'error'; d: { code: ErrorCode; min?: number; max?: number } };
export type JoinMode = 'open' | 'password' | 'invite';
export interface HelloPayload { protocol: number; publicKey: string /* b64url raw 32B */; nickname: string; locale: string;
  password?: string; inviteCode?: string; setupCode?: string; client: string }
export interface ChallengePayload { nonce: string /* b64url 32B */; serverKeyId: string }
export interface AuthProofPayload { signature: string /* b64url 64B */ }
export interface WelcomePayload {
  self: { userId: string; nickname: string; isOwner: boolean };
  sessionId: string;
  serverTime: number;              // ms epoch
  server: { name: string; version: string; joinMode: JoinMode; serverKeyId: string };
  features: string[];
  fileToken: string;               // main process strips it before forwarding to the renderer
  protocol: { min: number; max: number };
}
```

### `schemas.ts` (zod)
```ts
export const helloSchema: z.ZodType<HelloPayload>;            // strictObject; nickname 1..64 raw chars (normalized later); locale ≤ 16
export const authProofSchema: z.ZodType<AuthProofPayload>;    // strictObject
export const envelopeSchema;                                  // z.object({ t: z.string().max(64), id: z.number().int().nonnegative().optional(), d: z.unknown().optional() })
export const challengeSchemaClient;                           // z.object (client side)
export const welcomeSchemaClient;                             // z.object (client side)
export const resSchemaClient;                                 // union ok/err (client side)
export const errorEventSchemaClient;
```

### `auth.ts`
```ts
export function buildAuthMessage(serverKeyId: string, nonceB64u: string): Uint8Array;
// = utf8(`${CRYPTO_LABELS.authPrefix}\n${serverKeyId}\n${nonceB64u}`)
```

### `fingerprint.ts`
```ts
export function formatFingerprint(serverKeyId: string): string;
// first 20 bytes of fromBase64Url(serverKeyId) → base32 → 4 groups of 8, joined by ' ' (e.g. "ABCD2EFG HIJK3LMN OPQR4STU VWXY5Z23")
```

### `invite.ts`
```ts
export interface InvitePayload { addresses: string[] /* "host:port", 1..8 */; serverKeyId: string; inviteCode?: string; name?: string }
export function parseHostPort(s: string): { host: string; port: number }; // accepts "host", "host:port", "[v6]:port"; default port DEFAULT_PORT; throws ProtocolError('BAD_REQUEST')
export function formatInviteLink(p: InvitePayload): string;   // ghostlink://join?h=a,b&k=<id>&i=<code>&n=<name>
export function formatPasteCode(p: InvitePayload): string;    // "GL1-" + toBase64Url(utf8(JSON.stringify({h,k,i,n})))
export function formatWebLink(p: InvitePayload, siteBase: string): string; // `${siteBase}/j/#${formatPasteCode(p)}`
export type ParsedJoinInput =
  | { kind: 'invite'; invite: InvitePayload }
  | { kind: 'address'; address: string };                     // bare host[:port] → TOFU flow
export function parseJoinInput(input: string): ParsedJoinInput; // accepts link, paste code, web link, or host[:port]; enforces LIMITS; throws ProtocolError('BAD_REQUEST')
```

### `text.ts`
```ts
export function normalizeNickname(raw: string): { display: string; norm: string };
// NFKC → strip controls, bidi (U+202A–202E, U+2066–2069), zero-width (U+200B–200F, U+2060, U+FEFF) → trim/collapse spaces;
// 1..32 visible graphemes (Intl.Segmenter) else throw ProtocolError('BAD_REQUEST'); norm = display.toLocaleLowerCase('en-US')
```

### `version.ts`
```ts
export function negotiateProtocol(clientProtocol: number, server: { min: number; max: number }): boolean;
```

## 4. `@ghostlink/server` public API (`apps/server/src/index.ts`)

```ts
export interface StartServerOptions {
  dataDir: string;                 // created if missing
  port: number;                    // 0 = random (tests)
  host?: string;                   // default '0.0.0.0'
  name?: string;                   // used only on first run (seeds server_meta.name)
  publicAddresses?: string[];      // overrides server_meta.public_addresses when given
  joinMode?: JoinMode;             // first run only; default 'invite'
  logger?: Logger;
  now?: () => number;              // injectable clock for tests
}
export interface GhostServer {
  readonly port: number;           // actual bound port
  readonly serverKeyId: string;
  readonly version: string;
  readonly dataDir: string;
  setupCode(): string | null;      // null once consumed
  createInvite(opts?: { maxUses?: number; expiresInHours?: number; createdBy?: string }): InviteInfo;
  close(): Promise<void>;          // graceful: closes WS with SERVER_SHUTDOWN, HTTP, DB
}
export interface InviteInfo { code: string; link: string; pasteCode: string; webLink: string }
export function startServer(opts: StartServerOptions): Promise<GhostServer>;
export interface Logger { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void; error(msg: string, meta?: object): void }
export const SERVER_VERSION: string;  // read from apps/server/package.json at build time (import with { type: 'json' })
export const WEB_SITE_BASE = 'https://ghostlink.invalid';   // placeholder origin; replaced in M9 (single constant)
```

**Internal modules** (file → responsibility):
- `config/paths.ts`: data-dir layout helpers (`tls/`, `ghostlink.db`, `setup-code.txt`, `backups/`) and chmod 0600 on POSIX.
- `tls/certificate.ts`:
  - `loadOrCreateCertificate(dataDir): Promise<{ certPem: string; keyPem: string; serverKeyId: string }>`
  - `serverKeyIdFromDer(der: Uint8Array): string`
- `db/database.ts`:
  - `class Db { constructor(path: string); migrate(): void; tx<T>(fn: () => T): T; get/all/run helpers; close() }`
  - Migrate backs up with `VACUUM INTO` and refuses a newer `user_version`.
- `db/migrations/001_init.sql`: `server_meta`, `users`, `bans`, `invites`, exactly as spec §7. Later milestones add 002+.
- `auth/password.ts`: `hashPassword(pw): Promise<string>` (`scrypt$N$r$p$salt$hash`), `verifyPassword(pw, stored): Promise<boolean>`, with a concurrency limiter of 2.
- `auth/setupCode.ts`:
  - `ensureSetupCode(db, dataDir): string | null`
  - `consumeSetupCode(db, dataDir, code, userId): boolean` (atomic; deletes the file)
  - `resetSetupCode(db, dataDir): string`
- `auth/identity.ts`:
  - `userIdFromPublicKey(raw: Uint8Array): string`
  - `verifyAuthSignature(publicKeyRaw, message, signature): boolean` (JWK OKP import + `crypto.verify`)
- `auth/challenges.ts`: `ChallengeStore` holding a nonce per connection (single use, TTL).
- `auth/handshake.ts`: `runHandshake(conn, deps): Promise<AuthedSession>`. It is the state machine for hello → challenge → proof → membership and runs the atomic tx from spec §3.5.
- `invites/invites.ts`:
  - `createInvite(db, opts): { code }`
  - `consumeInviteTx(db, code, now): boolean` (must be called inside `db.tx`)
  - `buildInviteInfo(code, meta): InviteInfo`
- `ratelimit/limiter.ts`:
  - `class SlidingWindowLimiter { constructor(limit, windowMs, now) ; hit(key): boolean; peek(key): boolean }`
  - `ipKey(ip: string): string` groups IPv6 by /64 and handles IPv4-mapped addresses.
- `ws/connection.ts`: per-socket serial queue, deadlines, `send(envelope)`, `close(code)`.
- `ws/sessions.ts`: `SessionRegistry` with one session per userId; replacing a session closes the old one with SESSION_REPLACED.
- `ws/dispatch.ts`: maps request type to handler. M1 handles only `ping`. Unknown types get BAD_REQUEST.
- `http/server.ts`: `node:https` server with the routes `/health`, `HEAD|GET /` (CORS `*`) and the `/ws` upgrade. Uses `headersTimeout` 10 s and `requestTimeout` 30 s, and returns 404 for everything else.
- `cli.ts`: the `ghostlink-server` command with `start|invite|setup-code|status|version`. It uses `node:util.parseArgs`, and its output is in English.

**Test helper** (exported for desktop tests and m1a's own tests) at `apps/server/test/helpers/testClient.ts`:
```ts
export async function startTestServer(opts?: Partial<StartServerOptions>): Promise<{ server: GhostServer; dataDir: string; url: string; cleanup(): Promise<void> }>;
export async function connectTestClient(server: GhostServer, opts: { seed?: Uint8Array; nickname?: string; inviteCode?: string; password?: string; setupCode?: string; protocol?: number }): Promise<TestClient>;
// TestClient: { welcome?: WelcomePayload; error?: { code: ErrorCode }; request(t, d): Promise<ResOk|ResErr>; waitEvent(t): Promise<Envelope>; close(): void }
```

## 5. Desktop (`apps/desktop`) contracts

### Main process files
- `main/index.ts`: bootstrap order:
  1. `GHOSTLINK_USER_DATA` (only when `!app.isPackaged`)
  2. `app.commandLine.appendSwitch('disable-features','CacheCertVerification')`
  3. `protocol.registerSchemesAsPrivileged`
  4. `requestSingleInstanceLock`
  5. `whenReady` → `registerAppProtocol` → `installSecurity` → `IdentityStore.load()` → `registerIpc` → `createMainWindow`
  6. smoke mode
- `main/appProtocol.ts`: `registerAppProtocol(rendererDir: string)` makes `app://ghostlink/*` serve files from inside `rendererDir`. It blocks path traversal and falls back to `index.html`.
- `main/security.ts`: `installSecurity(opts: { appOrigin: string })`. It sets up web-contents-created guards, the permission request and check handlers, and blocks navigation.
- `main/identity.ts`:
  ```ts
  export type IdentityStatus = 'none' | 'ready' | 'locked';
  export class IdentityStore {
    static load(userDataDir: string, crypto: SafeStorageLike): IdentityStore;
    get status(): IdentityStatus;
    create(): void;                           // only when status==='none'
    retry(): IdentityStatus;
    replaceKeepingBackup(): void;             // only when status==='locked'; renames identity.bin → identity.bin.bak-<yyyyMMdd-HHmmss>
    serverKey(serverKeyId: string): ServerKey;
  }
  export interface ServerKey { publicKeyRaw: Uint8Array; sign(message: Uint8Array): Uint8Array }
  export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }
  export function deriveServerSeed(masterSeed: Uint8Array, serverKeyId: string): Uint8Array; // HKDF-SHA256(salt=CRYPTO_LABELS.identitySalt, info=serverKeyId, 32)
  ```
- `main/connection.ts`:
  ```ts
  export type ConnState = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'failed';
  export async function probeServerKeyId(address: string, opts?: { timeoutMs?: number }): Promise<string>; // TLS-only probe
  export class ServerConnection extends EventEmitter {
    constructor(opts: { addresses: string[]; serverKeyId: string; key: ServerKey; hello: Omit<HelloPayload,'publicKey'|'protocol'>; reconnect?: boolean });
    connect(): Promise<WelcomePayload>;       // races addresses (250 ms stagger, 5 s timeout each), pin checked on secureConnect
    request<T>(t: string, d?: unknown): Promise<T>; // rejects with ProtocolError
    close(): void;
    get state(): ConnState; get connectedAddress(): string | null;
    // events: 'state'(ConnState), 'welcome'(WelcomePayload), 'event'(Envelope), 'fatal'({code: ErrorCode})
  }
  ```
- `main/pinning.ts`: `setRendererPin(pin: { hostname: string; serverKeyId: string } | null): Promise<void>`. It installs `setCertificateVerifyProc` and calls `closeAllConnections()` on every change.
- `main/savedServers.ts`: JSON file `<userData>/servers.json` with `SavedServer = { id: string; name: string; addresses: string[]; serverKeyId: string; nickname: string; addedAt: number }`.
- `main/settings.ts`: `<userData>/settings.json` with `{ locale: 'pt-BR' | 'en'; nickname: string }`.
- `main/ipc.ts`: registers every handler below. Each handler checks `event.senderFrame` (main frame, app origin) and validates its args with zod.
- `main/hostProcess.ts` (M1: smoke only): `forkServer({ dataDir, port }): Promise<{ port: number; shutdown(): Promise<void> }>` via `utilityProcess.fork(serverEntry, [...args], { stdio: 'pipe', serviceName: 'GhostLink Server' })`, with a ready handshake over `parentPort` (`{ type: 'ready', port }`). The server entry is `src/main/serverEntry.ts`, bundled as a second main-process input.
- `main/smoke.ts`: if `process.env.GHOSTLINK_SMOKE === '1'`, the app waits for `did-finish-load`, forks the server on port 0, shuts it down and runs `app.exit(0)`. Any error gives `app.exit(1)`. There is a 60 s timeout.

### IPC API (`window.ghostlink`, typed in `src/shared/ipcTypes.ts` and used by both preload and renderer)
```ts
interface GhostlinkApi {
  app: { info(): Promise<{ version: string; platform: NodeJS.Platform; locale: string }> };
  identity: { status(): Promise<IdentityStatus>; create(): Promise<void>; retry(): Promise<IdentityStatus>; replaceKeepingBackup(): Promise<void> };
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  join: {
    parse(input: string): Promise<ParsedJoinInput>;                               // wraps shared.parseJoinInput
    probe(address: string): Promise<{ serverKeyId: string; fingerprint: string }>;
    connect(req: { addresses: string[]; serverKeyId: string; inviteCode?: string; password?: string; setupCode?: string; nickname: string; name?: string }): Promise<RendererWelcome>;
  };
  servers: { list(): Promise<SavedServer[]>; connect(id: string): Promise<RendererWelcome>; disconnect(): Promise<void>; remove(id: string): Promise<void> };
  onConnectionState(cb: (s: { state: ConnState; serverId: string | null; error?: ErrorCode }) => void): () => void;
  onServerEvent(cb: (e: Envelope) => void): () => void;
}
type RendererWelcome = Omit<WelcomePayload, 'fileToken'> & { serverId: string };
```
IPC channel names are `ghostlink:<namespace>.<method>` (e.g. `ghostlink:join.connect`). Events are `ghostlink:event.connectionState` and `ghostlink:event.server`. A failed call rejects with an `Error` whose `message` is the `ErrorCode`.

### Renderer
- React 19 + zustand.
- i18n: `src/renderer/i18n/{pt-BR,en}.ts` exporting `const messages = {...} as const`. The `en` object is typed `Record<keyof typeof ptBR, string>`, so a missing key fails typecheck. Access goes through `useT()`, which returns `t(key, vars?)`. Error codes map to `errors.<CODE>` keys.
- Screens (M1):
  - `IdentityLocked`
  - `Onboarding` (welcome → language + nickname → backup notice → choose Join/Host; Host is disabled with a "coming soon" note)
  - `Join` (input → TOFU fingerprint confirm → password or invite prompt on the matching error → nickname → connect)
  - `Connected` (placeholder: server name, fingerprint, state, disconnect)
  - `ServerList` (saved servers, reconnect)
- Styling: `styles/tokens.css` (spec §11 colors) + CSS modules. The Inter font is bundled from `@fontsource/inter` (pin the latest version).

## 6. CI / packaging contracts (m1c)

- `apps/desktop/electron-builder.yml`:
  - `appId: app.ghostlink.desktop` and `productName: GhostLink`.
  - `npmRebuild: false`, `asar: true`.
  - Windows `nsis`: `oneClick`, per-user, `include: build/installer.nsh`, and `artifactName` per spec §15.
  - macOS `dmg` for arm64 and x64 with `identity: "-"`, `hardenedRuntime`, the entitlements file and `minimumSystemVersion: "13.0"`.
  - `electronFuses` per spec §12.
  - `publish: null`.
  - `extraResources` for livekit is added in M5, not in M1.
- Root scripts:
  - `build` = typecheck all + `electron-vite build` + server esbuild bundle
  - `test` = vitest run
  - `lint` = eslint .
  - `typecheck` = tsc -p for each package
  - `dist` = `npm run build -w @ghostlink/desktop && electron-builder --config electron-builder.yml --publish never`, run in `apps/desktop`
  - `smoke` = `node scripts/smoke.mjs`, which launches the packaged app with `GHOSTLINK_SMOKE=1` and asserts exit code 0 within 60 s
- `.github/workflows/ci.yml`:
  - Job `test`: matrix [windows-latest, ubuntu-latest, macos-latest], Node 24.x. Runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`.
  - Job `package`: matrix [windows-latest, macos-latest]. Runs `npm ci`, `npm run dist`, `npm run smoke`. On macOS a temp keychain is created first. Artifacts are uploaded for 7 days.
  - Actions are pinned by commit SHA, with minimal `permissions: { contents: read }`.
