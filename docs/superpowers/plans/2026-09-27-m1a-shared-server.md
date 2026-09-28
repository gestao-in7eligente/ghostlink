# GhostLink M1a — Workspace, Shared Package and Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the npm-workspace foundation, `@ghostlink/shared` (protocol, schemas, invites, nickname rules) and `@ghostlink/server` (TLS-pinned HTTPS/WSS server with the complete Milestone 1 handshake, join modes, invites, owner setup code, rate limits and the `ghostlink-server` CLI), fully covered by unit and integration tests.

**Architecture:** Two TypeScript workspaces export their *source* (`packages/shared`, `apps/server`); Vitest, tsx and esbuild compile it on the fly. The server is a library (`startServer()` → `GhostServer`) wrapped by a CLI: it owns a self-signed ECDSA P-256 certificate whose SPKI hash is the server identity (`serverKeyId`), a `node:sqlite` database with numbered, backed-up migrations, and a WebSocket gateway that runs hello → challenge → Ed25519 proof → one synchronous admission transaction. Integration tests start real servers on random loopback ports and talk to them with a pinned `ws` client that uses the same pinning technique as the desktop app.

**Tech Stack:** Node ≥ 24.14 · npm workspaces · TypeScript 6.0.3 · Vitest 5.0.2 (+ Vite 7.3.6) · ESLint 10.11.0 + typescript-eslint 8.70.1 · zod 4.6.5 · ws 8.22.0 · @peculiar/x509 2.1.0 + reflect-metadata 0.2.2 · node:sqlite · esbuild 0.28.2 · tsx 4.23.15

---

## Before you start (read once)

**Authoritative sources.** Names, signatures, versions and paths come from `docs/superpowers/plans/2026-09-27-m1-interfaces.md` (the "contract"). Behaviour comes from `docs/superpowers/specs/2026-09-27-ghostlink-design.md` (Portuguese; §3 identity/auth, §4 transport, §5 protocol, §7 data, §13 rate limits, §14 tests). Where this plan adds something the contract does not name, the addition is listed in **Contract notes** at the end.

**Scope.** Root scaffolding, `packages/shared`, `apps/server`. Nothing from Electron/desktop, CI workflows or packaging (plans 1b and 1c).

**Branch.** If you are on `main` and your executor did not create a worktree, first run `git switch -c m1a-shared-server`.

**Environment facts (verified on the dev machine).**
- System Node is 24.14.0. Its `node:sqlite` prints `ExperimentalWarning: SQLite is an experimental feature…`. The root `npm test` script sets `NODE_OPTIONS=--disable-warning=ExperimentalWarning` through `cross-env`, and the server's own scripts pass the flag. If you see that warning line anywhere else it is harmless.
- The network is flaky: every `npm install` uses `--fetch-retries=6 --fetch-retry-mintimeout=5000`; `curl` uses `--retry 5`. Just re-run on a transient failure.
- All commands are POSIX-shell and work in Git Bash on Windows and on GitHub Actions (ubuntu/macos/windows). Run them **from the repository root** unless a step says otherwise.
- Run one test file (or several) with `npm test -- <path> [<path>…]` from the root. Vitest prints a summary such as `Test Files  2 passed (2)` / `Tests  8 passed (8)`.

**TypeScript 6 gotcha (verified).** In TS 6.0 the `types` compiler option defaults to `[]`: without `"types": ["node"]`, `process`, `Buffer` and `node:*` modules are unknown. The configs below set it explicitly per package.

**Coding conventions.**
- ESM everywhere (`"type": "module"`). Relative imports inside a package end in `.js` (NodeNext): `import { x } from './invite.js'`. Cross-package imports use the package name: `import { parseInvite } from '@ghostlink/shared'`.
- `import type` for type-only imports (`verbatimModuleSyntax` is on and ESLint enforces `consistent-type-imports`). No `any`.
- `packages/shared/src` must not use Node-only APIs or the DOM: its tsconfig has no Node types (so `Buffer`/`node:*` fail to typecheck) and ESLint forbids `node:*`, `Buffer`, `process`, `window`, `document` there. Only APIs present in Node, Electron main and the sandboxed renderer (`TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `Intl.Segmenter`) are allowed.
- Code, identifiers, comments, CLI output and commit messages are in English. No user-facing UI strings exist in this plan (the server sends only error codes; the desktop translates them in plan 1b).
- Tests assert behaviour and security properties (limits, malicious input, races), not implementation details.

**Commits.** Conventional style. Every commit message ends with a blank line and the trailer shown in each task. Always use the heredoc form given in the task:
```bash
git commit -m "$(cat <<'EOF'
feat(scope): summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## File Structure

Every file created by this plan and its single responsibility.

**Root**

| File | Responsibility |
|---|---|
| `package.json` | Workspace root: `workspaces`, `engines`, root scripts (`typecheck`, `test`, `lint`, `build`), shared dev tooling versions |
| `package-lock.json` | Generated by `npm install`; committed |
| `tsconfig.base.json` | Strict compiler options shared by all packages (NodeNext, ES2023, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noEmit`) |
| `vitest.config.ts` | Declares the Vitest projects (`packages/shared`, `apps/server`; plan 1b appends `apps/desktop`) |
| `eslint.config.js` | Flat config: `@eslint/js` + typescript-eslint recommended, plus the "shared stays platform-neutral" rules |
| `.gitignore`, `.gitattributes` | Ignore build output/data/secrets; force LF line endings |
| `LICENSE` | Official GPL-3.0 text (downloaded, checksum-verified) |
| `README.md` | Short pt-BR project description and dev commands |

**`packages/shared`** (`@ghostlink/shared`, exports `./src/index.ts`)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Package manifest (dep: zod), DOM-lib/no-Node-types typecheck, Vitest project `shared` |
| `src/index.ts` | Re-exports every module below |
| `src/constants.ts` | `APP_NAME`, `APP_ID`, `DEFAULT_PORT`, `PROTOCOL`, frozen `CRYPTO_LABELS`, `LIMITS` |
| `src/errors.ts` | Closed `ERROR_CODES` enum, `ErrorCode`, `isErrorCode`, `ProtocolError` |
| `src/encoding.ts` | Strict base64url, base32 (RFC 4648), UTF-8 encode/strict decode — pure JS |
| `src/protocol.ts` | Envelope/response/event types and the M1 handshake payload types |
| `src/schemas.ts` | zod schemas: strict server-side (`helloSchema`, `authProofSchema`, `envelopeSchema`) and lenient client-side |
| `src/auth.ts` | `buildAuthMessage` — the exact bytes signed in `auth.proof` |
| `src/fingerprint.ts` | `formatFingerprint` — 160-bit base32 TOFU fingerprint in 4 groups |
| `src/version.ts` | `negotiateProtocol` |
| `src/text.ts` | `normalizeNickname` (NFKC, invisible/bidi stripping, grapheme limits) and `sanitizeLabel` |
| `src/invite.ts` | `parseHostPort`/`formatHostPort`, invite link / paste code / web link formatting, `parseJoinInput`, `normalizeInviteCode` |
| `test/*.test.ts` | One test file per module above |

**`apps/server`** (`@ghostlink/server`, exports `./src/index.ts`, bin `ghostlink-server` → `dist/cli.js`)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Manifest (deps: shared, ws, x509, reflect-metadata, zod), Node-typed typecheck, Vitest project `server` |
| `scripts/build.mjs` | esbuild bundle of `src/bin.ts` → `dist/cli.js` (+ copies `dist/migrations/`) |
| `src/index.ts` | Public API: `startServer`, `GhostServer`, `StartServerOptions`, `InviteInfo`, `Logger`, `SERVER_VERSION`, `WEB_SITE_BASE` |
| `src/version.ts` | `SERVER_VERSION` (from package.json via JSON import attributes), `WEB_SITE_BASE` |
| `src/logger.ts` | `Logger` interface, `consoleLogger`, `silentLogger` |
| `src/limits.ts` | `ServerLimits` (mutable copy of `LIMITS`) and `resolveLimits(overrides)` |
| `src/config/paths.ts` | Data-dir layout, directory creation (0700), atomic writes, 0600 secret files |
| `src/util/semaphore.ts` | FIFO counting semaphore (used to cap concurrent scrypt) |
| `src/tls/certificate.ts` | Generate/load the self-signed certificate; `serverKeyIdFromDer` |
| `src/db/database.ts` | `Db` wrapper over `node:sqlite` (pragmas, cached statements, sync-only `tx`), migrations with `VACUUM INTO` backups and refuse-newer |
| `src/db/migrations/001_init.sql` | `server_meta`, `users`, `bans`, `invites` (spec §7) |
| `src/db/serverMeta.ts` | Typed access to the single `server_meta` row |
| `src/auth/password.ts` | scrypt hash/verify with at most 2 concurrent derivations |
| `src/auth/setupCode.ts` | Owner setup code: generate, store hash + 0600 file, check, consume atomically, rotate |
| `src/auth/identity.ts` | `userIdFromPublicKey`, `verifyAuthSignature` (Ed25519 via JWK), small-order key blocklist |
| `src/auth/challenges.ts` | `ChallengeStore`: one single-use, expiring nonce per connection; pending-per-IP cap |
| `src/auth/admission.ts` | `admit()`: join-mode rules and the one synchronous membership transaction (spec §3.5) |
| `src/auth/handshake.ts` | `runHandshake()`: hello → challenge → proof → admission state machine, failure accounting |
| `src/invites/invites.ts` | `createInvite`, `consumeInviteTx`, `buildInviteInfo`, `InviteInfo` |
| `src/ratelimit/limiter.ts` | `SlidingWindowLimiter`, `ipKey` (IPv6 /64 grouping, IPv4-mapped) |
| `src/ws/connection.ts` | One socket: validated envelope inbox (serial processing), deadlines, heartbeat, close with error code |
| `src/ws/sessions.ts` | `SessionRegistry`: one session per identity, `SESSION_REPLACED` |
| `src/ws/dispatch.ts` | Request type → handler (M1: `ping`); error mapping |
| `src/ws/gateway.ts` | Upgrade handling, pre-auth connection caps, limiter wiring, handshake → welcome → request loop, graceful close |
| `src/http/server.ts` | `node:https` server: `/health`, `HEAD|GET /` (CORS `*`), `/ws` upgrade, 404, header/request timeouts |
| `src/cli.ts` | `runCli()`: `start | invite | setup-code | status | version` (English output) |
| `src/bin.ts` | Executable entry bundled into `dist/cli.js` |
| `test/helpers/identity.ts` | `makeIdentity(seed)` — Ed25519 test identity built like the desktop's |
| `test/helpers/testClient.ts` | `startTestServer`, `connectTestClient`, `connectRaw` (pinned `ws` client) — reusable by plan 1b |
| `test/helpers/db.ts` | Direct DB tweaks for states that have no API yet in M1 (bans, removal, password, max members) |
| `test/*.test.ts` | Unit tests, one per module |
| `test/integration/*.test.ts` | Real-server tests: HTTP routes, handshake, membership, limits, lifecycle, CLI, bundle |

---

### Task 1: Workspace scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `README.md`, `LICENSE`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`

This task is configuration only; its "test" is that the toolchain runs cleanly on an empty workspace.

- [ ] **Step 1: Create the root `package.json`**

The `build` script covers shared + server only; plan 1b extends it with the desktop build. `engines` follows the contract.

```json
{
  "name": "ghostlink",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "engines": {
    "node": ">=24.14"
  },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "cross-env NODE_OPTIONS=--disable-warning=ExperimentalWarning vitest run",
    "lint": "eslint .",
    "build": "npm run typecheck && npm run build -w @ghostlink/server"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "24.19.0",
    "cross-env": "10.1.0",
    "eslint": "10.11.0",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.1",
    "vite": "7.3.6",
    "vitest": "5.0.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

`types: []` here is deliberate (TS 6 default made explicit); each package opts into the types it needs.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  }
}
```

- [ ] **Step 3: Create the root `vitest.config.ts`**

Verified: Vitest 5 aborts with `Projects definition references a non-existing file or a directory` if a listed project directory is missing, so `apps/desktop` is **not** listed yet (plan 1b adds it together with the directory).

```ts
import { defineConfig } from 'vitest/config';

// Plan 1b appends 'apps/desktop' once that directory exists:
// Vitest 5 refuses to start when a listed project directory is missing.
export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/server'],
  },
});
```

- [ ] **Step 4: Create `eslint.config.js`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/out/**', '**/coverage/**', '**/.data/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // spec §2.1: shared runs in Node, Electron main and the sandboxed renderer.
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: '@ghostlink/shared must not use Node-only APIs.' }] },
      ],
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require', 'window', 'document'],
    },
  },
);
```

- [ ] **Step 5: Create `.gitignore` and `.gitattributes`**

`.gitignore`:

```gitignore
# dependencies
node_modules/

# build output
dist/
out/
coverage/

# LiveKit binaries are downloaded at build time (M5)
resources/livekit/

# local data and secrets
.data/
*.db
*.db-wal
*.db-shm
.env
.env.*

# logs and OS noise
*.log
.DS_Store
Thumbs.db
```

`.gitattributes` (LF everywhere; binaries untouched):

```gitignore
* text=auto eol=lf

*.png binary
*.ico binary
*.icns binary
*.woff2 binary
```

- [ ] **Step 6: Create `README.md` (pt-BR)**

````markdown
# GhostLink

App desktop gratuito e de código aberto (Windows e macOS) para chat de texto, voz, câmera e tela, no estilo do Discord — sem conta central. Qualquer pessoa pode hospedar o próprio servidor, pelo app ou numa VPS.

> **Status:** em desenvolvimento (Milestone 1: fundação). Ainda não há release.

## Desenvolvimento

Requisitos: Node.js 24.14 ou mais novo.

```bash
npm install          # instala todos os workspaces
npm test             # testes de unidade e integração (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript em todos os pacotes
npm run build        # gera apps/server/dist/cli.js (servidor para VPS)
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`). O design completo está em `docs/superpowers/specs/`.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
````

- [ ] **Step 7: Download the official GPL-3.0 text into `LICENSE` and verify it**

Run:
```bash
curl -fsSL --retry 5 --retry-delay 3 https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE
node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('LICENSE')).digest('hex'))"
head -n 2 LICENSE
```
Expected: the hash `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` and the lines `GNU GENERAL PUBLIC LICENSE` / `Version 3, 29 June 2007` (indented). If `curl` fails, re-run it; never type or paraphrase the license text.

- [ ] **Step 8: Create the shared package skeleton**

`packages/shared/package.json`:

```json
{
  "name": "@ghostlink/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "zod": "4.6.5"
  }
}
```

`packages/shared/tsconfig.json` — DOM lib (for `TextEncoder`, `URL`, `Intl.Segmenter` types) and **no Node types**, so any Node-only API in shared fails to typecheck. The server's typecheck compiles shared's source again with Node types and no DOM, which catches DOM-only APIs:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": []
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 9: Create the server package skeleton**

`apps/server/package.json` (the `bin` target is produced in Task 24; `npm install` does not need it to exist):

```json
{
  "name": "@ghostlink/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "exports": {
    ".": "./src/index.ts"
  },
  "bin": {
    "ghostlink-server": "./dist/cli.js"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "build": "node scripts/build.mjs",
    "dev": "node --disable-warning=ExperimentalWarning --import tsx src/bin.ts"
  },
  "dependencies": {
    "@ghostlink/shared": "*",
    "@peculiar/x509": "2.1.0",
    "reflect-metadata": "0.2.2",
    "ws": "8.22.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/ws": "8.18.1",
    "esbuild": "0.28.2",
    "tsx": "4.23.15"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/server/vitest.config.ts` (integration tests start real servers, hence the longer timeouts):

```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
```

- [ ] **Step 10: Install dependencies**

Run:
```bash
npm install --fetch-retries=6 --fetch-retry-mintimeout=5000 --no-audit --no-fund
ls node_modules/@ghostlink
```
Expected: `added 15x packages` (the exact number may differ slightly) and the listing `server  shared` (workspace links).

- [ ] **Step 11: Verify the toolchain on the empty workspace**

Run:
```bash
npm run typecheck && npm run lint && npx vitest run --passWithNoTests
```
Expected: both `tsc -p tsconfig.json` runs exit silently, ESLint prints nothing, and Vitest prints `No test files found, exiting with code 0`. Overall exit code 0.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts eslint.config.js .gitignore .gitattributes README.md LICENSE packages/shared/package.json packages/shared/tsconfig.json packages/shared/vitest.config.ts apps/server/package.json apps/server/tsconfig.json apps/server/vitest.config.ts
git commit -m "$(cat <<'EOF'
chore: scaffold npm workspaces with TypeScript, Vitest and ESLint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared constants and error codes

**Files:**
- Create: `packages/shared/src/constants.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/constants.test.ts`, `packages/shared/test/errors.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/constants.test.ts` — pins the frozen cryptographic labels (changing them would silently break every identity and signature) and the spec §13 limits:

```ts
import { describe, expect, it } from 'vitest';
import { APP_ID, CRYPTO_LABELS, DEFAULT_PORT, LIMITS, PROTOCOL } from '../src/index.js';

describe('frozen constants (spec §3.6)', () => {
  it('keeps the cryptographic domain strings byte-for-byte', () => {
    // Changing any of these breaks every existing identity, signature or invite.
    expect(CRYPTO_LABELS).toEqual({
      identitySalt: 'ghostlink/identity/v1',
      authPrefix: 'ghostlink-auth-v1',
      fileHmac: 'ghostlink-file-v1',
      keyFileMagic: 'GLKEY',
      pastePrefix: 'GL1-',
      scheme: 'ghostlink',
    });
    expect(APP_ID).toBe('app.ghostlink.desktop');
  });

  it('keeps protocol and port defaults consistent', () => {
    expect(PROTOCOL.min).toBeLessThanOrEqual(PROTOCOL.current);
    expect(PROTOCOL.current).toBeLessThanOrEqual(PROTOCOL.max);
    expect(DEFAULT_PORT).toBe(7700);
  });

  it('matches the spec §13 limits', () => {
    expect(LIMITS).toMatchObject({
      maxPayloadBytes: 262_144,
      helloTimeoutMs: 5_000,
      proofTimeoutMs: 10_000,
      challengeTtlMs: 30_000,
      maxUnauthenticatedConnections: 256,
      maxConnectionsPerIp: 20,
      authFailuresPerIpPerMinute: 10,
      pendingChallengesPerIp: 5,
      newIdentitiesPerIpPerHour: 5,
      requestsPerSecondPerSession: 30,
      nicknameMaxVisible: 32,
      inviteMaxAddresses: 8,
      inviteMaxLength: 2048,
    });
  });
});
```

`packages/shared/test/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ProtocolError, isErrorCode } from '../src/index.js';

describe('error codes', () => {
  it('is a closed set without duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('contains every handshake code from spec §3.3', () => {
    for (const code of ['PROTOCOL_UNSUPPORTED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID', 'BAD_SIGNATURE',
      'CHALLENGE_EXPIRED', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'RATE_LIMITED', 'BAD_SETUP_CODE',
      'SESSION_REPLACED', 'SERVER_SHUTDOWN']) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it('isErrorCode rejects anything outside the enum', () => {
    for (const x of ['bad_request', 'BAD_REQUEST ', '', 'toString', '__proto__', 42, null, undefined, {}, ['BAD_REQUEST']]) {
      expect(isErrorCode(x), String(x)).toBe(false);
    }
  });
});

describe('ProtocolError', () => {
  it('carries code, message and extra', () => {
    const e = new ProtocolError('PROTOCOL_UNSUPPORTED', 'too old', { min: 1, max: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProtocolError');
    expect(e.code).toBe('PROTOCOL_UNSUPPORTED');
    expect(e.message).toBe('too old');
    expect(e.extra).toEqual({ min: 1, max: 1 });
  });

  it('defaults the message to the code', () => {
    expect(new ProtocolError('BANNED').message).toBe('BANNED');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/shared/test/constants.test.ts packages/shared/test/errors.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement `constants.ts` (exactly as in the contract)**

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

- [ ] **Step 4: Implement `errors.ts`**

```ts
export const ERROR_CODES = [
  'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'HIERARCHY', 'RATE_LIMITED', 'INTERNAL',
  'PROTOCOL_UNSUPPORTED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID', 'BAD_SIGNATURE',
  'CHALLENGE_EXPIRED', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'BAD_SETUP_CODE',
  'SESSION_REPLACED', 'KICKED', 'SERVER_SHUTDOWN',
  'CHANNEL_FULL', 'FILE_TOO_LARGE', 'IMAGE_TOO_LARGE', 'QUOTA_EXCEEDED', 'BAD_ATTACHMENT', 'OWNER_MUST_TRANSFER',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && ERROR_CODE_SET.has(x);
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'ProtocolError';
  }
}
```

- [ ] **Step 5: Create `index.ts`**

```ts
export * from './constants.js';
export * from './errors.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- packages/shared/test/constants.test.ts packages/shared/test/errors.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  8 passed (8)`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/errors.ts packages/shared/src/index.ts packages/shared/test/constants.test.ts packages/shared/test/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add frozen constants, limits and error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Strict base64url, base32 and UTF-8 helpers

**Files:**
- Create: `packages/shared/src/encoding.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/encoding.test.ts`

Why strict: keys, nonces and signatures travel as base64url. The decoder rejects padding, the `+`/`/` alphabet, whitespace, impossible lengths and non-canonical trailing bits, so each byte string has exactly one accepted spelling. No `Buffer` (shared must run in the renderer).

- [ ] **Step 1: Write the failing test**

`packages/shared/test/encoding.test.ts` (RFC 4648 §10 vectors for both alphabets):

```ts
import { describe, expect, it } from 'vitest';
import { ProtocolError, fromBase64Url, fromUtf8, toBase32, toBase64Url, utf8 } from '../src/index.js';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('base64url', () => {
  // RFC 4648 §10 vectors (base64url and base64 agree on these, minus padding).
  const vectors: Array<[string, string]> = [
    ['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy'],
  ];
  it.each(vectors)('encodes %j as %j and back', (plain, encoded) => {
    expect(toBase64Url(ascii(plain))).toBe(encoded);
    expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(ascii(plain)));
  });

  it('uses the URL-safe alphabet (- and _ instead of + and /)', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(toBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
    expect(Array.from(fromBase64Url('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('round-trips every byte value and every length up to 70', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all));
    for (let len = 0; len <= 70; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('encodes 32 bytes as 43 chars and 64 bytes as 86 chars', () => {
    expect(toBase64Url(new Uint8Array(32))).toHaveLength(43);
    expect(toBase64Url(new Uint8Array(64))).toHaveLength(86);
  });

  it.each([
    ['padding', 'Zg=='],
    ['standard alphabet +', 'a+b/'],
    ['whitespace', 'Zm9v Zg'],
    ['newline', 'Zm9v\n'],
    ['impossible length', 'Zm9vY'],
    ['non-ASCII', 'Zm9é'],
    ['non-canonical trailing bits ("Zh" vs canonical "Zg")', 'Zh'],
    ['non-canonical trailing bits ("Zm9" vs canonical "Zm8")', 'Zm9'],
  ])('rejects %s', (_label, input) => {
    expect(() => fromBase64Url(input)).toThrow(ProtocolError);
    try {
      fromBase64Url(input);
    } catch (e) {
      expect((e as ProtocolError).code).toBe('BAD_REQUEST');
    }
  });

  it('rejects non-string input', () => {
    expect(() => fromBase64Url(123 as unknown as string)).toThrow(ProtocolError);
  });
});

describe('base32 (RFC 4648 §6, no padding)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('encodes %j as %j', (plain, encoded) => {
    expect(toBase32(ascii(plain))).toBe(encoded);
  });

  it('only emits A-Z and 2-7', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase32(all)).toMatch(/^[A-Z2-7]+$/);
    expect(toBase32(new Uint8Array(20))).toHaveLength(32);
  });
});

describe('utf8', () => {
  it('encodes multi-byte characters', () => {
    expect(Array.from(utf8('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8('👻'))).toEqual([0xf0, 0x9f, 0x91, 0xbb]);
  });

  it('fromUtf8 round-trips and refuses malformed bytes', () => {
    expect(fromUtf8(utf8('olá 👻'))).toBe('olá 👻');
    expect(() => fromUtf8(new Uint8Array([0xc3]))).toThrow(ProtocolError);
    expect(() => fromUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(ProtocolError); // encoded surrogate
    expect(() => fromUtf8(new Uint8Array([0xc0, 0xaf]))).toThrow(ProtocolError); // overlong '/'
  });

  it('keeps a BOM as a character instead of silently dropping it', () => {
    expect(fromUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('﻿A');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- packages/shared/test/encoding.test.ts`
Expected: FAIL — `TypeError: toBase64Url is not a function` (not exported yet).

- [ ] **Step 3: Implement `encoding.ts`**

```ts
import { ProtocolError } from './errors.js';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const B64URL_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) table[B64URL_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function invalid(what: string): ProtocolError {
  return new ProtocolError('BAD_REQUEST', `invalid ${what}`);
}

/** RFC 4648 §5 base64url, without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!
      + B64URL_ALPHABET[(n >> 6) & 63]! + B64URL_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict base64url decoder: rejects padding, the '+' and '/' alphabet, whitespace,
 * impossible lengths and non-canonical trailing bits (so every byte string has
 * exactly one accepted encoding).
 */
export function fromBase64Url(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 4 === 1) throw invalid('base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64URL_LOOKUP[c]! : -1;
    if (v < 0) throw invalid('base64url');
    buffer = ((buffer << 6) | v) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw invalid('base64url');
  return out;
}

/** RFC 4648 §6 base32 (A–Z, 2–7), without padding. */
export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >> bits) & 31]!;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31]!;
  return out;
}

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decoding: malformed bytes throw instead of becoming U+FFFD; a BOM is kept as a character. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw invalid('UTF-8');
  }
}
```

- [ ] **Step 4: Export it from `index.ts`**

Replace `packages/shared/src/index.ts` with:
```ts
export * from './constants.js';
export * from './errors.js';
export * from './encoding.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- packages/shared/test/encoding.test.ts`
Expected: PASS — `Tests  30 passed (30)`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/encoding.ts packages/shared/src/index.ts packages/shared/test/encoding.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add strict base64url, base32 and UTF-8 helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Protocol types and zod schemas

**Files:**
- Create: `packages/shared/src/protocol.ts`, `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts`

Rules (spec §5.1, contract §1): the server validates with `z.strictObject` (unknown keys are an error → `BAD_REQUEST`); client-side schemas use `z.object` (unknown keys are stripped) and map unknown error codes from newer servers to `INTERNAL` so old clients keep working. `helloSchema` accepts any integer `protocol` so the server can answer `PROTOCOL_UNSUPPORTED` with `min`/`max` instead of a generic `BAD_REQUEST`. Verified with zod 4.6.5: `z.number().int()` already rejects unsafe integers; `strictObject` rejects an own `__proto__` key.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  authProofSchema,
  challengeSchemaClient,
  envelopeSchema,
  errorEventSchemaClient,
  helloSchema,
  resSchemaClient,
  toBase64Url,
  welcomeSchemaClient,
} from '../src/index.js';

const B32 = toBase64Url(new Uint8Array(32).fill(1));
const B64 = toBase64Url(new Uint8Array(64).fill(2));
const validHello = {
  protocol: 1,
  publicKey: B32,
  nickname: 'Ana',
  locale: 'pt-BR',
  client: 'ghostlink/0.1.0 (win32)',
};

describe('helloSchema (server side, strict)', () => {
  it('accepts a minimal hello and every optional credential', () => {
    expect(helloSchema.safeParse(validHello).success).toBe(true);
    expect(helloSchema.safeParse({ ...validHello, password: 'x', inviteCode: 'ABCDEFGH23', setupCode: 'a-b' }).success).toBe(true);
  });

  it('accepts any integer protocol so the server can answer PROTOCOL_UNSUPPORTED', () => {
    expect(helloSchema.safeParse({ ...validHello, protocol: 99 }).success).toBe(true);
  });

  it.each([
    ['unknown key', { ...validHello, admin: true }],
    ['__proto__ key', JSON.parse(`{"protocol":1,"publicKey":"${B32}","nickname":"a","locale":"en","client":"c","__proto__":{"x":1}}`)],
    ['missing client', { ...validHello, client: undefined }],
    ['fractional protocol', { ...validHello, protocol: 1.5 }],
    ['protocol as string', { ...validHello, protocol: '1' }],
    ['public key of 31 bytes', { ...validHello, publicKey: toBase64Url(new Uint8Array(31)) }],
    ['public key with padding', { ...validHello, publicKey: `${B32.slice(0, 42)}=` }],
    ['empty nickname', { ...validHello, nickname: '' }],
    ['nickname over 64 raw chars', { ...validHello, nickname: 'a'.repeat(65) }],
    ['locale over 16 chars', { ...validHello, locale: 'pt-BR-xxxxxxxxxxx' }],
    ['locale with injection', { ...validHello, locale: 'en"><script>' }],
    ['empty password', { ...validHello, password: '' }],
    ['password over 256 chars', { ...validHello, password: 'p'.repeat(257) }],
    ['client over 128 chars', { ...validHello, client: 'c'.repeat(129) }],
    ['array payload', [validHello]],
    ['null payload', null],
  ])('rejects %s', (_label, value) => {
    expect(helloSchema.safeParse(value).success).toBe(false);
  });
});

describe('authProofSchema', () => {
  it('accepts a 64-byte signature only', () => {
    expect(authProofSchema.safeParse({ signature: B64 }).success).toBe(true);
    expect(authProofSchema.safeParse({ signature: B32 }).success).toBe(false);
    expect(authProofSchema.safeParse({ signature: B64, extra: 1 }).success).toBe(false);
  });
});

describe('envelopeSchema', () => {
  it('accepts requests and events', () => {
    expect(envelopeSchema.parse({ t: 'ping', id: 1, d: {} })).toEqual({ t: 'ping', id: 1, d: {} });
    expect(envelopeSchema.parse({ t: 'hello', d: { a: 1 } })).toEqual({ t: 'hello', d: { a: 1 } });
  });

  it.each([
    ['negative id', { t: 'x', id: -1 }],
    ['fractional id', { t: 'x', id: 1.5 }],
    ['unsafe integer id', { t: 'x', id: 2 ** 53 }],
    ['long type', { t: 'x'.repeat(65) }],
    ['missing type', { id: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(envelopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('client-side schemas (strip unknown keys, tolerate new error codes)', () => {
  const welcome = {
    self: { userId: 'a'.repeat(32), nickname: 'Ana', isOwner: true },
    sessionId: 's1',
    serverTime: 1,
    server: { name: 'S', version: '0.1.0', joinMode: 'invite', serverKeyId: B32 },
    features: [],
    fileToken: 'tok',
    protocol: { min: 1, max: 1 },
  };

  it('welcome strips unknown fields added by newer servers', () => {
    const parsed = welcomeSchemaClient.parse({ ...welcome, channels: [], extra: 1 });
    expect(parsed).toEqual(welcome);
  });

  it('welcome rejects a malformed userId or join mode', () => {
    expect(welcomeSchemaClient.safeParse({ ...welcome, self: { ...welcome.self, userId: 'x' } }).success).toBe(false);
    expect(welcomeSchemaClient.safeParse({ ...welcome, server: { ...welcome.server, joinMode: 'closed' } }).success).toBe(false);
  });

  it('challenge requires 32-byte nonce and key id', () => {
    expect(challengeSchemaClient.safeParse({ nonce: B32, serverKeyId: B32, x: 1 }).success).toBe(true);
    expect(challengeSchemaClient.safeParse({ nonce: 'short', serverKeyId: B32 }).success).toBe(false);
  });

  it('res distinguishes ok and error, mapping unknown codes to INTERNAL', () => {
    expect(resSchemaClient.parse({ t: 'res', id: 3, ok: true, d: { t: 5 } })).toEqual({ t: 'res', id: 3, ok: true, d: { t: 5 } });
    const err = resSchemaClient.parse({ t: 'res', id: 3, ok: false, error: { code: 'FROM_THE_FUTURE', message: 'm' } });
    expect(err).toEqual({ t: 'res', id: 3, ok: false, error: { code: 'INTERNAL', message: 'm' } });
    expect(resSchemaClient.safeParse({ t: 'res', id: 3, ok: 'yes' }).success).toBe(false);
  });

  it('error event keeps min/max for PROTOCOL_UNSUPPORTED', () => {
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } }))
      .toEqual({ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } });
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'NEW_CODE' } }).d.code).toBe('INTERNAL');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- packages/shared/test/schemas.test.ts`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'safeParse')`.

- [ ] **Step 3: Create `protocol.ts` (types exactly as in the contract)**

```ts
import type { ErrorCode } from './errors.js';

export type Envelope = { t: string; id?: number; d?: unknown };
export type ResOk<T = unknown> = { t: 'res'; id: number; ok: true; d: T };
export type ResErr = { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } };
export type ServerErrorEvent = { t: 'error'; d: { code: ErrorCode; min?: number; max?: number } };
export type JoinMode = 'open' | 'password' | 'invite';

export interface HelloPayload {
  protocol: number;
  publicKey: string; // b64url raw 32B
  nickname: string;
  locale: string;
  password?: string;
  inviteCode?: string;
  setupCode?: string;
  client: string;
}

export interface ChallengePayload {
  nonce: string; // b64url 32B
  serverKeyId: string;
}

export interface AuthProofPayload {
  signature: string; // b64url 64B
}

export interface WelcomePayload {
  self: { userId: string; nickname: string; isOwner: boolean };
  sessionId: string;
  serverTime: number; // ms epoch
  server: { name: string; version: string; joinMode: JoinMode; serverKeyId: string };
  features: string[];
  fileToken: string; // main process strips it before forwarding to the renderer
  protocol: { min: number; max: number };
}
```

- [ ] **Step 4: Create `schemas.ts`**

```ts
import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import type { AuthProofPayload, ChallengePayload, HelloPayload, WelcomePayload } from './protocol.js';

/** base64url (no padding) of exactly `bytes` bytes. */
function b64u(bytes: number) {
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));
}

const errorCodeClient = z.enum(ERROR_CODES).catch('INTERNAL');

// ---- server side: strict, unknown keys are an error (spec §5.1) ----

export const helloSchema: z.ZodType<HelloPayload> = z.strictObject({
  protocol: z.number().int(),
  publicKey: b64u(32),
  nickname: z.string().min(1).max(64),
  locale: z.string().max(16).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/),
  password: z.string().min(1).max(256).optional(),
  inviteCode: z.string().min(1).max(64).optional(),
  setupCode: z.string().min(1).max(64).optional(),
  client: z.string().min(1).max(128),
});

export const authProofSchema: z.ZodType<AuthProofPayload> = z.strictObject({
  signature: b64u(64),
});

export const envelopeSchema = z.object({
  t: z.string().max(64),
  id: z.number().int().nonnegative().optional(),
  d: z.unknown().optional(),
});

// ---- client side: z.object strips unknown keys; unknown error codes become INTERNAL ----

export const challengeSchemaClient: z.ZodType<ChallengePayload> = z.object({
  nonce: b64u(32),
  serverKeyId: b64u(32),
});

export const welcomeSchemaClient: z.ZodType<WelcomePayload> = z.object({
  self: z.object({
    userId: z.string().regex(/^[0-9a-f]{32}$/),
    nickname: z.string().min(1).max(256),
    isOwner: z.boolean(),
  }),
  sessionId: z.string().min(1).max(128),
  serverTime: z.number(),
  server: z.object({
    name: z.string().max(256),
    version: z.string().max(64),
    joinMode: z.enum(['open', 'password', 'invite']),
    serverKeyId: b64u(32),
  }),
  features: z.array(z.string().max(64)).max(256),
  fileToken: z.string().min(1).max(256),
  protocol: z.object({ min: z.number().int(), max: z.number().int() }),
});

export const resSchemaClient = z.discriminatedUnion('ok', [
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(true), d: z.unknown() }),
  z.object({
    t: z.literal('res'),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.object({ code: errorCodeClient, message: z.string().max(1024) }),
  }),
]);

export const errorEventSchemaClient = z.object({
  t: z.literal('error'),
  d: z.object({
    code: errorCodeClient,
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
});
```

- [ ] **Step 5: Export both from `index.ts`**

Replace `packages/shared/src/index.ts` with:
```ts
export * from './constants.js';
export * from './errors.js';
export * from './encoding.js';
export * from './protocol.js';
export * from './schemas.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- packages/shared/test/schemas.test.ts`
Expected: PASS — `Tests  30 passed (30)`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/schemas.ts packages/shared/src/index.ts packages/shared/test/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add protocol types and zod schemas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Auth message, fingerprint and protocol negotiation

**Files:**
- Create: `packages/shared/src/auth.ts`, `packages/shared/src/fingerprint.ts`, `packages/shared/src/version.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/auth.test.ts`, `packages/shared/test/fingerprint.test.ts`, `packages/shared/test/version.test.ts`

`buildAuthMessage` produces the exact bytes signed in `auth.proof` (spec §3.3). It refuses inputs that are not base64url of 32 bytes, so no caller can smuggle a `\n` and shift field boundaries. `formatFingerprint` is what the TOFU screen and `ghostlink-server status` both display.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProtocolError, buildAuthMessage, toBase64Url } from '../src/index.js';

const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));
const NONCE = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

describe('buildAuthMessage', () => {
  it('produces the exact frozen byte layout', () => {
    const bytes = buildAuthMessage(KEY_ID, NONCE);
    const expected = `ghostlink-auth-v1\n${KEY_ID}\n${NONCE}`;
    expect(new TextDecoder().decode(bytes)).toBe(expected);
    expect(bytes).toHaveLength(17 + 1 + 43 + 1 + 43);
    expect(bytes[17]).toBe(0x0a);
    expect(bytes[17 + 1 + 43]).toBe(0x0a);
  });

  it('changes when the serverKeyId changes (binding to the TLS key)', () => {
    const other = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(buildAuthMessage(KEY_ID, NONCE)).not.toEqual(buildAuthMessage(other, NONCE));
  });

  it('is not symmetric in its arguments', () => {
    expect(buildAuthMessage(KEY_ID, NONCE)).not.toEqual(buildAuthMessage(NONCE, KEY_ID));
  });

  it.each([
    ['newline smuggled into serverKeyId', `${KEY_ID.slice(0, 42)}\n`, NONCE],
    ['short serverKeyId', KEY_ID.slice(0, 42), NONCE],
    ['padded nonce', KEY_ID, `${NONCE.slice(0, 42)}=`],
    ['empty nonce', KEY_ID, ''],
  ])('rejects %s', (_label, keyId, nonce) => {
    expect(() => buildAuthMessage(keyId, nonce)).toThrow(ProtocolError);
  });
});
```

`packages/shared/test/fingerprint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProtocolError, formatFingerprint, toBase32, toBase64Url } from '../src/index.js';

describe('formatFingerprint', () => {
  it('shows the first 20 bytes in base32 as 4 groups of 8', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const fp = formatFingerprint(toBase64Url(bytes));
    expect(fp).toMatch(/^[A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8}$/);
    expect(fp.replaceAll(' ', '')).toBe(toBase32(bytes.subarray(0, 20)));
  });

  it('matches a fixed vector', () => {
    const zeros = toBase64Url(new Uint8Array(32));
    expect(formatFingerprint(zeros)).toBe('AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA');
    const ff = toBase64Url(new Uint8Array(32).fill(0xff));
    expect(formatFingerprint(ff)).toBe('77777777 77777777 77777777 77777777');
  });

  it('ignores bytes 20..31 (only 160 bits are shown)', () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    b[31] = 1;
    expect(formatFingerprint(toBase64Url(a))).toBe(formatFingerprint(toBase64Url(b)));
    const c = new Uint8Array(32);
    c[19] = 1;
    expect(formatFingerprint(toBase64Url(a))).not.toBe(formatFingerprint(toBase64Url(c)));
  });

  it.each([
    ['31 bytes', toBase64Url(new Uint8Array(31))],
    ['33 bytes', toBase64Url(new Uint8Array(33))],
    ['not base64url', '!'.repeat(43)],
  ])('rejects %s', (_label, id) => {
    expect(() => formatFingerprint(id)).toThrow(ProtocolError);
  });
});
```

`packages/shared/test/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PROTOCOL, negotiateProtocol } from '../src/index.js';

describe('negotiateProtocol', () => {
  it('accepts the current protocol', () => {
    expect(negotiateProtocol(PROTOCOL.current, PROTOCOL)).toBe(true);
  });

  it('accepts every version inside [min, max] and nothing outside', () => {
    const server = { min: 2, max: 4 };
    expect([1, 2, 3, 4, 5].map((v) => negotiateProtocol(v, server))).toEqual([false, true, true, true, false]);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 0])('rejects %s', (v) => {
    expect(negotiateProtocol(v, { min: 1, max: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- packages/shared/test/auth.test.ts packages/shared/test/fingerprint.test.ts packages/shared/test/version.test.ts`
Expected: FAIL — `TypeError: buildAuthMessage is not a function` (and the same for `formatFingerprint`, `negotiateProtocol`).

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { CRYPTO_LABELS } from './constants.js';
import { utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';

const B64U_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * The exact bytes a client signs in `auth.proof` (spec §3.3):
 * UTF-8 of "ghostlink-auth-v1\n" + serverKeyId + "\n" + nonce.
 * Both inputs must be base64url of 32 bytes, so neither can smuggle a '\n'
 * and shift the field boundaries.
 */
export function buildAuthMessage(serverKeyId: string, nonceB64u: string): Uint8Array {
  if (!B64U_32_BYTES.test(serverKeyId) || !B64U_32_BYTES.test(nonceB64u)) {
    throw new ProtocolError('BAD_REQUEST', 'serverKeyId and nonce must be base64url of 32 bytes');
  }
  return utf8(`${CRYPTO_LABELS.authPrefix}\n${serverKeyId}\n${nonceB64u}`);
}
```

- [ ] **Step 4: Implement `fingerprint.ts`**

```ts
import { fromBase64Url, toBase32 } from './encoding.js';
import { ProtocolError } from './errors.js';

/**
 * Human-comparable fingerprint (spec §3.3 TOFU): the first 20 bytes (160 bits)
 * of the serverKeyId in base32, as 4 groups of 8 characters.
 */
export function formatFingerprint(serverKeyId: string): string {
  const bytes = fromBase64Url(serverKeyId);
  if (bytes.length !== 32) throw new ProtocolError('BAD_REQUEST', 'serverKeyId must be 32 bytes');
  const b32 = toBase32(bytes.subarray(0, 20));
  return [b32.slice(0, 8), b32.slice(8, 16), b32.slice(16, 24), b32.slice(24, 32)].join(' ');
}
```

- [ ] **Step 5: Implement `version.ts`**

```ts
/** True when the client's protocol version is inside the server's [min, max] range (spec §5.1). */
export function negotiateProtocol(clientProtocol: number, server: { min: number; max: number }): boolean {
  return Number.isInteger(clientProtocol) && clientProtocol >= server.min && clientProtocol <= server.max;
}
```

- [ ] **Step 6: Export them from `index.ts`**

Replace `packages/shared/src/index.ts` with:
```ts
export * from './constants.js';
export * from './errors.js';
export * from './encoding.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './auth.js';
export * from './fingerprint.js';
export * from './version.js';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- packages/shared/test/auth.test.ts packages/shared/test/fingerprint.test.ts packages/shared/test/version.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  20 passed (20)`.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/auth.ts packages/shared/src/fingerprint.ts packages/shared/src/version.ts packages/shared/src/index.ts packages/shared/test/auth.test.ts packages/shared/test/fingerprint.test.ts packages/shared/test/version.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add auth message, fingerprint and protocol negotiation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Nickname normalization

**Files:**
- Create: `packages/shared/src/text.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/text.test.ts`

Spec §7 / contract §3: NFKC → strip controls, bidi and zero-width characters → trim/collapse whitespace → 1..32 visible graphemes (`Intl.Segmenter`) → `norm = display.toLocaleLowerCase('en-US')`. Implementation details that close real spoofing holes (all verified on Node 24):
- It strips the whole `\p{Cf}` category (a superset of the listed bidi/zero-width ranges; also soft hyphen, invisible operators, tag characters, U+061C), `\p{Cc}`, lone surrogates, and blank-looking non-`Cf` characters (Hangul fillers U+115F/U+1160/U+3164/U+FFA0, U+034F, U+17B4/U+17B5, Braille blank U+2800) — the classic "invisible name" tricks.
- A **second NFKC pass** after stripping: `"e" + ZWJ + U+0301` would otherwise normalize to `"é"` and not collide with `"é"`.
- At least one letter/number/punctuation/symbol is required; more than 10 code points in one grapheme ("Zalgo") is rejected; raw input over 256 UTF-16 units is rejected before NFKC (which can expand text up to 18×).
- Known, accepted trade-off: stripping U+200D splits emoji ZWJ sequences (👨‍👩‍👧 → 👨👩👧). The test documents it.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProtocolError, normalizeNickname, sanitizeLabel } from '../src/index.js';

function rejects(raw: string): void {
  let caught: unknown;
  try {
    normalizeNickname(raw);
  } catch (e) {
    caught = e;
  }
  expect(caught, JSON.stringify(raw)).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('normalizeNickname', () => {
  it('keeps ordinary names and lowercases the uniqueness key', () => {
    expect(normalizeNickname('Ana')).toEqual({ display: 'Ana', norm: 'ana' });
    expect(normalizeNickname('João Silva')).toEqual({ display: 'João Silva', norm: 'joão silva' });
    expect(normalizeNickname('幽霊')).toEqual({ display: '幽霊', norm: '幽霊' });
  });

  it('applies NFKC so compatibility look-alikes collide', () => {
    expect(normalizeNickname('ＡＤＭＩＮ').norm).toBe('admin'); // fullwidth letters
    expect(normalizeNickname('ﬁsh').display).toBe('fish'); // ligature
    expect(normalizeNickname('é').display).toBe('é'); // decomposed accent is composed
    expect(normalizeNickname('Café').norm).toBe(normalizeNickname('Café').norm);
  });

  it('strips bidi controls (U+202A–202E, U+2066–2069, LRM/RLM, ALM)', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
      const c = String.fromCodePoint(cp);
      expect(normalizeNickname(`ad${c}min`).display, cp.toString(16)).toBe('admin');
    }
    // The classic "RLO" spoof: displays as "admin" reversed tail, must normalize to plain text.
    expect(normalizeNickname('‮nimda').display).toBe('nimda');
  });

  it('strips zero-width and other invisible characters', () => {
    for (const cp of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x034f, 0x180e, 0x2061, 0xe0041]) {
      const c = String.fromCodePoint(cp);
      expect(normalizeNickname(`ad${c}min`).norm, cp.toString(16)).toBe('admin');
    }
  });

  it('strips control characters (C0 and C1)', () => {
    expect(normalizeNickname('a\u0000b\u0007c\u009fd').display).toBe('abcd');
    expect(normalizeNickname('a\nb').display).toBe('ab');
  });

  it('removes lone surrogates', () => {
    expect(normalizeNickname('ab\uD800c').display).toBe('abc');
  });

  it('collapses and trims whitespace, including exotic spaces', () => {
    expect(normalizeNickname('  Ana   Maria  ').display).toBe('Ana Maria');
    expect(normalizeNickname('Ana 　Maria').display).toBe('Ana Maria');
    expect(normalizeNickname('Ana Maria').display).toBe('Ana Maria');
  });

  it('is idempotent on tricky inputs', () => {
    const inputs = ['e‍́', 'ＡＤＭＩＮ', '  x‮ y ', 'ﬁ­sh', 'Anaㅤ', '각'];
    for (const raw of inputs) {
      const once = normalizeNickname(raw).display;
      expect(normalizeNickname(once).display, JSON.stringify(raw)).toBe(once);
    }
  });

  it('composes characters that become adjacent after stripping (look-alike loophole)', () => {
    // "e" + ZWJ + combining acute: without the second NFKC pass this would be
    // "é" and not collide with "é".
    expect(normalizeNickname('e‍́').norm).toBe(normalizeNickname('é').norm);
  });

  it('counts graphemes, not UTF-16 code units', () => {
    expect(normalizeNickname('👻'.repeat(32)).display).toBe('👻'.repeat(32)); // 64 code units, 32 graphemes
    expect(normalizeNickname('🇧🇷'.repeat(32)).display).toBe('🇧🇷'.repeat(32)); // flags are 1 grapheme each
    expect(normalizeNickname('a'.repeat(32)).display).toHaveLength(32);
    rejects('a'.repeat(33));
    rejects('👻'.repeat(33));
  });

  it('splits emoji ZWJ sequences because U+200D is stripped (documented trade-off)', () => {
    // 👨‍👩‍👧 becomes three separate emoji: 3 graphemes.
    expect(normalizeNickname('👨‍👩‍👧').display).toBe('👨👩👧');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['only zero-width', '​‌‍'],
    ['only bidi controls', '‮⁦'],
    ['only Hangul filler (invisible name trick)', 'ㅤ'],
    ['only Braille blank', '⠀⠀'],
    ['only a variation selector', '️'],
    ['only combining marks', '́̂'],
    ['Zalgo stack', `a${'́'.repeat(20)}`],
    ['longer than 256 raw chars', 'a'.repeat(257)],
  ])('rejects %s', (_label, raw) => {
    rejects(raw);
  });

  it('rejects non-string input', () => {
    rejects(42 as unknown as string);
  });
});

describe('sanitizeLabel', () => {
  it('cleans like a nickname and truncates by graphemes', () => {
    expect(sanitizeLabel('  Meu‮ Servidor  ', 64)).toBe('Meu Servidor');
    expect(sanitizeLabel('👻'.repeat(10), 3)).toBe('👻👻👻');
    expect(sanitizeLabel('abc   def', 4)).toBe('abc');
  });

  it('returns an empty string when nothing visible is left', () => {
    expect(sanitizeLabel('​ㅤ ', 64)).toBe('');
    expect(sanitizeLabel(123 as unknown as string, 64)).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- packages/shared/test/text.test.ts`
Expected: FAIL — `TypeError: normalizeNickname is not a function`.

- [ ] **Step 3: Implement `text.ts`**

Note the regex: combining marks (U+034F, U+17B4, U+17B5) sit *outside* the character class; inside it ESLint's `no-misleading-character-class` fails (verified).

```ts
import { LIMITS } from './constants.js';
import { ProtocolError } from './errors.js';

/**
 * Characters removed from user-visible labels:
 * - \p{Cc}: C0/C1 controls;
 * - \p{Cf}: format characters — includes every bidi control (U+061C, U+200E/F,
 *   U+202A–202E, U+2066–2069), zero-width characters (U+200B–200D, U+2060, U+FEFF),
 *   the soft hyphen, invisible operators and tag characters;
 * - \p{Cs}: lone surrogates (JSON can carry them; SQLite would turn them into U+FFFD);
 * - blank-looking letters/marks that are not Cf: U+034F (combining grapheme joiner),
 *   Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), Khmer inherent vowels
 *   (U+17B4, U+17B5) and the Braille blank (U+2800).
 */
// The combining marks live outside the class: inside it they would trip no-misleading-character-class.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}ᅟᅠ⠀ㅤﾠ]|͏|឴|឵/gu;
/** A label must contain at least one letter, number, punctuation or symbol (emoji are symbols). */
const HAS_VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** Longest raw input we are willing to normalize (NFKC can expand text up to 18x). */
const MAX_RAW_LENGTH = 256;
/** Caps "Zalgo" stacks of combining marks; real scripts stay well below this. */
const MAX_CODE_POINTS_PER_GRAPHEME = 10;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function cleanLabel(raw: string): string {
  // The second NFKC pass composes sequences that only become adjacent once
  // invisible characters are removed (e.g. "e" + ZWJ + U+0301 -> "é"), which
  // makes the result idempotent and closes a look-alike loophole.
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFKC');
}

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/**
 * Normalizes a nickname (spec §7): NFKC, strips controls, bidi and zero-width
 * characters, collapses whitespace and requires 1..32 visible graphemes.
 * `norm` is the uniqueness key stored in users.nickname_norm.
 */
export function normalizeNickname(raw: string): { display: string; norm: string } {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) {
    throw new ProtocolError('BAD_REQUEST', 'nickname too long');
  }
  const display = cleanLabel(raw);
  const parts = graphemes(display);
  if (parts.length < 1 || parts.length > LIMITS.nicknameMaxVisible || !HAS_VISIBLE.test(display)) {
    throw new ProtocolError('BAD_REQUEST', 'nickname must have 1 to 32 visible characters');
  }
  if (parts.some((g) => [...g].length > MAX_CODE_POINTS_PER_GRAPHEME)) {
    throw new ProtocolError('BAD_REQUEST', 'nickname has too many combining marks');
  }
  return { display, norm: display.toLocaleLowerCase('en-US') };
}

/**
 * Cleans a free-form label (server name, invite name hint) the same way as a
 * nickname, then truncates it to `maxGraphemes`. Returns '' when nothing
 * visible is left. Never throws on content.
 */
export function sanitizeLabel(raw: string, maxGraphemes: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = cleanLabel(raw.slice(0, MAX_RAW_LENGTH * 4));
  if (!HAS_VISIBLE.test(cleaned)) return '';
  return graphemes(cleaned).slice(0, maxGraphemes).join('').trim();
}
```

- [ ] **Step 4: Export it from `index.ts`**

Replace `packages/shared/src/index.ts` with:
```ts
export * from './constants.js';
export * from './errors.js';
export * from './encoding.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './auth.js';
export * from './fingerprint.js';
export * from './text.js';
export * from './version.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- packages/shared/test/text.test.ts`
Expected: PASS — `Tests  24 passed (24)`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/text.ts packages/shared/src/index.ts packages/shared/test/text.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add nickname normalization

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Invite formats and join-input parsing

**Files:**
- Create: `packages/shared/src/invite.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/invite.test.ts`

Formats (spec §3.5, contract §3): `ghostlink://join?h=a,b&k=<serverKeyId>&i=<code>&n=<name>`, paste code `GL1-` + base64url(UTF-8(JSON `{h,k,i,n}`)) with `h` as an array, web link `${siteBase}/j/#GL1-…` (fragment only, never sent to a web server). `parseJoinInput` accepts all three plus a bare `host[:port]` (TOFU flow). Everything is validated (spec §12): 1..8 addresses, ports 1..65535, total length ≤ 2048 checked *before* parsing, canonical 43-char `serverKeyId`, 10-char base32 invite code (case-insensitive), `n` sanitized like a nickname and treated as a hint. IPv6 must be bracketed (a bare `::1:7700` is ambiguous). `URLSearchParams` is used for both formatting and parsing, so any name round-trips.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/invite.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  LIMITS,
  ProtocolError,
  formatHostPort,
  formatInviteLink,
  formatPasteCode,
  formatWebLink,
  normalizeInviteCode,
  parseHostPort,
  parseJoinInput,
  toBase64Url,
  utf8,
  type InvitePayload,
} from '../src/index.js';

const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i * 7));
const SITE = 'https://ghostlink.invalid';

function expectBadRequest(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('parseHostPort', () => {
  it.each([
    ['example.com', 'example.com', DEFAULT_PORT],
    ['Example.COM:7701', 'example.com', 7701],
    ['192.168.0.10', '192.168.0.10', DEFAULT_PORT],
    ['26.1.2.3:1', '26.1.2.3', 1],
    ['localhost:65535', 'localhost', 65535],
    ['[::1]', '::1', DEFAULT_PORT],
    ['[::1]:7700', '::1', 7700],
    ['[2001:DB8:0:0:0:0:0:1]:9000', '2001:db8::1', 9000],
    ['my-host.tail1234.ts.net:7700', 'my-host.tail1234.ts.net', 7700],
  ])('parses %j', (input, host, port) => {
    expect(parseHostPort(input)).toEqual({ host, port });
  });

  it.each([
    '', ':7700', 'host:', 'host:0', 'host:65536', 'host:+80', 'host:80x', 'host:0x50', 'host:007700',
    '::1', '2001:db8::1', // bare IPv6 is ambiguous with a port
    '[::1', '[::1]x', '[not-ip]:1', '[fe80::1%eth0]:1',
    '256.1.1.1', '1.2.3', '01.2.3.4', 'user@host', 'host/path', 'host name', '-host', 'host-', 'a..b', 'host.',
    'ho_st', 'hóst', `${'a'.repeat(64)}.com`, `${'a.'.repeat(126)}com`,
  ])('rejects %j', (input) => {
    expectBadRequest(() => parseHostPort(input));
  });

  it('formatHostPort brackets IPv6 and round-trips', () => {
    for (const s of ['example.com:7700', '10.0.0.1:1', '[::1]:7700', '[2001:db8::1]:9000']) {
      const { host, port } = parseHostPort(s);
      expect(formatHostPort(host, port)).toBe(s);
    }
  });
});

describe('normalizeInviteCode', () => {
  it('uppercases valid codes', () => {
    expect(normalizeInviteCode('abcdefgh23')).toBe('ABCDEFGH23');
    expect(normalizeInviteCode(' ABCDEFGH23 ')).toBe('ABCDEFGH23');
  });

  it.each(['', 'ABCDEFGH2', 'ABCDEFGH234', 'ABCDEFGH01', 'ABCDEFGH-2', 'ÁBCDEFGH23'])('rejects %j', (c) => {
    expect(normalizeInviteCode(c)).toBeNull();
  });
});

describe('invite formats', () => {
  const payload: InvitePayload = {
    addresses: ['203.0.113.5:7700', 'Casa.Example.com:7710', '[2001:db8::5]:7700'],
    serverKeyId: KEY_ID,
    inviteCode: 'ABCDEFGH23',
    name: 'Servidor do Zé',
  };
  const normalized: InvitePayload = { ...payload, addresses: ['203.0.113.5:7700', 'casa.example.com:7710', '[2001:db8::5]:7700'] };

  it('link round-trips through parseJoinInput', () => {
    const link = formatInviteLink(payload);
    expect(link.startsWith('ghostlink://join?')).toBe(true);
    expect(parseJoinInput(link)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('paste code round-trips and has the frozen prefix', () => {
    const code = formatPasteCode(payload);
    expect(code).toMatch(/^GL1-[A-Za-z0-9_-]+$/);
    expect(parseJoinInput(code)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('web link carries the paste code only in the fragment', () => {
    const web = formatWebLink(payload, `${SITE}/`);
    const url = new URL(web);
    expect(url.origin + url.pathname).toBe(`${SITE}/j/`);
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#${formatPasteCode(payload)}`);
    expect(parseJoinInput(web)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('omits optional fields and still round-trips', () => {
    const minimal: InvitePayload = { addresses: ['10.0.0.1:7700'], serverKeyId: KEY_ID };
    expect(parseJoinInput(formatInviteLink(minimal))).toEqual({ kind: 'invite', invite: minimal });
    expect(parseJoinInput(formatPasteCode(minimal))).toEqual({ kind: 'invite', invite: minimal });
  });

  it('accepts a trailing slash after the link host (Windows shells add it)', () => {
    const link = formatInviteLink(payload).replace('ghostlink://join?', 'ghostlink://join/?');
    expect(parseJoinInput(link)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('deduplicates addresses and fills the default port', () => {
    const p: InvitePayload = { addresses: ['a.example', 'a.example:7700', 'A.EXAMPLE'], serverKeyId: KEY_ID };
    expect(parseJoinInput(formatPasteCode(p))).toEqual({
      kind: 'invite',
      invite: { addresses: ['a.example:7700'], serverKeyId: KEY_ID },
    });
  });

  it('sanitizes the name hint (bidi spoofing) and drops an invisible one', () => {
    const spoof = parseJoinInput(formatPasteCode({ ...payload, name: 'Banco‮ oficial' }));
    expect(spoof.kind === 'invite' && spoof.invite.name).toBe('Banco oficial');
    const invisible = parseJoinInput(formatPasteCode({ ...payload, name: '​ㅤ' }));
    expect(invisible.kind === 'invite' && 'name' in invisible.invite).toBe(false);
  });
});

describe('parseJoinInput limits and malicious input', () => {
  const base: InvitePayload = { addresses: ['10.0.0.1:7700'], serverKeyId: KEY_ID };
  const paste = (obj: unknown) => `GL1-${toBase64Url(utf8(JSON.stringify(obj)))}`;

  it('treats a bare host[:port] as a TOFU address', () => {
    expect(parseJoinInput('  192.168.0.2 ')).toEqual({ kind: 'address', address: '192.168.0.2:7700' });
    expect(parseJoinInput('[::1]:7701')).toEqual({ kind: 'address', address: '[::1]:7701' });
    expect(parseJoinInput('Meu-PC.local:7700')).toEqual({ kind: 'address', address: 'meu-pc.local:7700' });
  });

  it(`accepts ${LIMITS.inviteMaxAddresses} addresses and rejects ${LIMITS.inviteMaxAddresses + 1}`, () => {
    const addrs = (n: number) => Array.from({ length: n }, (_, i) => `10.0.0.${i + 1}:7700`);
    expect(parseJoinInput(formatPasteCode({ ...base, addresses: addrs(8) })).kind).toBe('invite');
    expectBadRequest(() => formatPasteCode({ ...base, addresses: addrs(9) }));
    expectBadRequest(() => parseJoinInput(paste({ h: addrs(9), k: KEY_ID })));
    expectBadRequest(() => parseJoinInput(`ghostlink://join?h=${addrs(9).join(',')}&k=${KEY_ID}`));
  });

  it(`rejects input longer than ${LIMITS.inviteMaxLength} characters before parsing`, () => {
    expectBadRequest(() => parseJoinInput(`ghostlink://join?h=a:1&k=${KEY_ID}&n=${'x'.repeat(2100)}`));
    expectBadRequest(() => parseJoinInput(`GL1-${'A'.repeat(2100)}`));
  });

  it('refuses to format an invite that would exceed the limit', () => {
    // 8 distinct, individually valid 251-char hostnames.
    const long = Array.from({ length: 8 }, (_, i) =>
      `${String.fromCharCode(97 + i)}${'x'.repeat(59)}.${'y'.repeat(60)}.${'z'.repeat(60)}.${'w'.repeat(60)}.example:7700`);
    expect(() => parseHostPort(long[0]!)).not.toThrow();
    expectBadRequest(() => formatInviteLink({ ...base, addresses: long }));
    expectBadRequest(() => formatPasteCode({ ...base, addresses: long }));
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['wrong scheme host', `ghostlink://evil?h=10.0.0.1:1&k=${KEY_ID}`],
    ['credentials in link', `ghostlink://user@join?h=10.0.0.1:1&k=${KEY_ID}`],
    ['link without k', 'ghostlink://join?h=10.0.0.1:1'],
    ['link without h', `ghostlink://join?k=${KEY_ID}`],
    ['duplicate h', `ghostlink://join?h=10.0.0.1:1&h=10.0.0.2:1&k=${KEY_ID}`],
    ['empty address in list', `ghostlink://join?h=10.0.0.1:1,,10.0.0.2:1&k=${KEY_ID}`],
    ['port out of range', `ghostlink://join?h=10.0.0.1:70000&k=${KEY_ID}`],
    ['short serverKeyId', `ghostlink://join?h=10.0.0.1:1&k=${KEY_ID.slice(1)}`],
    ['malformed invite code', `ghostlink://join?h=10.0.0.1:1&k=${KEY_ID}&i=abc`],
    ['paste code with bad base64', 'GL1-%%%'],
    ['paste code with invalid UTF-8', `GL1-${toBase64Url(new Uint8Array([0x7b, 0xff, 0x7d]))}`],
    ['paste code that is not JSON', `GL1-${toBase64Url(utf8('not json'))}`],
    ['paste code with JSON array', paste([1, 2])],
    ['paste code with h as string', paste({ h: '10.0.0.1:1', k: KEY_ID })],
    ['paste code with javascript: address', paste({ h: ['javascript:alert(1)'], k: KEY_ID })],
    ['paste code with __proto__ pollution attempt', `GL1-${toBase64Url(utf8(`{"__proto__":{"x":1},"h":["a:1"],"k":"${KEY_ID}","i":1}`))}`],
    ['web link without fragment', `${SITE}/j/`],
    ['web link with foreign fragment', `${SITE}/j/#hello`],
    ['javascript URL', 'javascript:alert(1)'],
    ['file URL', 'file:///etc/passwd'],
  ])('rejects %s', (_label, input) => {
    expectBadRequest(() => parseJoinInput(input));
  });

  it('rejects non-string input', () => {
    expectBadRequest(() => parseJoinInput(undefined as unknown as string));
  });

  it('does not pollute Object.prototype', () => {
    try {
      parseJoinInput(`GL1-${toBase64Url(utf8(`{"__proto__":{"polluted":1},"h":["a:1"],"k":"${KEY_ID}"}`))}`);
    } catch {
      // either outcome is fine; pollution is not
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- packages/shared/test/invite.test.ts`
Expected: FAIL — `TypeError: parseHostPort is not a function`.

- [ ] **Step 3: Implement `invite.ts`**

```ts
import { z } from 'zod';
import { CRYPTO_LABELS, DEFAULT_PORT, LIMITS } from './constants.js';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';
import { sanitizeLabel } from './text.js';

export interface InvitePayload {
  addresses: string[]; // "host:port", 1..8
  serverKeyId: string;
  inviteCode?: string;
  name?: string;
}

export type ParsedJoinInput =
  | { kind: 'invite'; invite: InvitePayload }
  | { kind: 'address'; address: string }; // bare host[:port] → TOFU flow

const INVITE_NAME_MAX_GRAPHEMES = 64;
const MAX_ADDRESS_LENGTH = 262; // "[" + 45-char IPv6 + "]:" + port, or a 253-char hostname + ":65535"
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const PORT = /^[0-9]{1,5}$/;
const SERVER_KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const INVITE_CODE = /^[A-Z2-7]{10}$/;

function bad(message: string): ProtocolError {
  return new ProtocolError('BAD_REQUEST', message);
}

function normalizeIPv6(host: string): string {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(host)) throw bad('invalid IPv6 address');
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    throw bad('invalid IPv6 address');
  }
}

/**
 * Parses "host", "host:port", "[v6]" or "[v6]:port". Hostnames are lowercased;
 * IPv6 is returned without brackets in canonical form. Default port: DEFAULT_PORT.
 */
export function parseHostPort(s: string): { host: string; port: number } {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_ADDRESS_LENGTH) throw bad('invalid address');
  let host: string;
  let portText: string | undefined;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) throw bad('invalid address');
    host = normalizeIPv6(s.slice(1, end));
    const rest = s.slice(end + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
    else if (rest !== '') throw bad('invalid address');
  } else {
    const parts = s.split(':');
    if (parts.length > 2) throw bad('IPv6 addresses must be written in brackets');
    host = parts[0]!.toLowerCase();
    portText = parts[1];
    const numeric = /^[0-9.]+$/.test(host);
    if (numeric ? !IPV4.test(host) : !HOSTNAME.test(host)) throw bad('invalid host');
  }
  let port = DEFAULT_PORT;
  if (portText !== undefined) {
    if (!PORT.test(portText)) throw bad('invalid port');
    port = Number(portText);
    if (port < 1 || port > 65535) throw bad('invalid port');
  }
  return { host, port };
}

/** Inverse of parseHostPort: brackets IPv6 literals. */
export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Uppercases and validates an invite code (10 base32 characters); null when malformed. */
export function normalizeInviteCode(code: string): string | null {
  if (typeof code !== 'string') return null;
  const upper = code.trim().toUpperCase();
  return INVITE_CODE.test(upper) ? upper : null;
}

function normalizePayload(p: InvitePayload): InvitePayload {
  if (!Array.isArray(p.addresses) || p.addresses.length < 1 || p.addresses.length > LIMITS.inviteMaxAddresses) {
    throw bad(`an invite needs 1 to ${LIMITS.inviteMaxAddresses} addresses`);
  }
  const addresses: string[] = [];
  for (const a of p.addresses) {
    const { host, port } = parseHostPort(a);
    const canonical = formatHostPort(host, port);
    if (!addresses.includes(canonical)) addresses.push(canonical);
  }
  if (typeof p.serverKeyId !== 'string' || !SERVER_KEY_ID.test(p.serverKeyId) || fromBase64Url(p.serverKeyId).length !== 32) {
    throw bad('invalid serverKeyId');
  }
  const out: InvitePayload = { addresses, serverKeyId: p.serverKeyId };
  if (p.inviteCode !== undefined) {
    const code = normalizeInviteCode(p.inviteCode);
    if (code === null) throw bad('invalid invite code');
    out.inviteCode = code;
  }
  if (p.name !== undefined) {
    const name = sanitizeLabel(p.name, INVITE_NAME_MAX_GRAPHEMES);
    if (name !== '') out.name = name;
  }
  return out;
}

function checkLength(s: string): string {
  if (s.length > LIMITS.inviteMaxLength) throw bad('invite too long');
  return s;
}

/** ghostlink://join?h=a,b&k=<serverKeyId>&i=<code>&n=<name> */
export function formatInviteLink(p: InvitePayload): string {
  const v = normalizePayload(p);
  const q = new URLSearchParams();
  q.set('h', v.addresses.join(','));
  q.set('k', v.serverKeyId);
  if (v.inviteCode !== undefined) q.set('i', v.inviteCode);
  if (v.name !== undefined) q.set('n', v.name);
  return checkLength(`${CRYPTO_LABELS.scheme}://join?${q.toString()}`);
}

/** "GL1-" + base64url(UTF-8(JSON {h, k, i, n})) */
export function formatPasteCode(p: InvitePayload): string {
  const v = normalizePayload(p);
  const json = JSON.stringify({ h: v.addresses, k: v.serverKeyId, i: v.inviteCode, n: v.name });
  return checkLength(CRYPTO_LABELS.pastePrefix + toBase64Url(utf8(json)));
}

/** `${siteBase}/j/#GL1-…` — the fragment never reaches any web server. */
export function formatWebLink(p: InvitePayload, siteBase: string): string {
  return checkLength(`${siteBase.replace(/\/+$/, '')}/j/#${formatPasteCode(p)}`);
}

const pasteJsonSchema = z.object({
  h: z.array(z.string().max(MAX_ADDRESS_LENGTH)).min(1).max(LIMITS.inviteMaxAddresses),
  k: z.string().max(64),
  i: z.string().max(64).optional(),
  n: z.string().max(1024).optional(),
});

function parseInviteLink(s: string): InvitePayload {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad('invalid invite link');
  }
  if (url.protocol !== `${CRYPTO_LABELS.scheme}:` || url.hostname !== 'join' || url.port !== ''
    || url.username !== '' || url.password !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw bad('invalid invite link');
  }
  const params = url.searchParams;
  for (const key of ['h', 'k', 'i', 'n']) {
    if (params.getAll(key).length > 1) throw bad(`duplicate "${key}" parameter`);
  }
  const h = params.get('h');
  const k = params.get('k');
  if (h === null || k === null) throw bad('invite link needs h and k');
  const payload: InvitePayload = { addresses: h.split(','), serverKeyId: k };
  const i = params.get('i');
  const n = params.get('n');
  if (i !== null) payload.inviteCode = i;
  if (n !== null) payload.name = n;
  return normalizePayload(payload);
}

function parsePasteCode(s: string): InvitePayload {
  const body = s.slice(CRYPTO_LABELS.pastePrefix.length);
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(fromBase64Url(body)));
  } catch {
    throw bad('invalid invite code');
  }
  const parsed = pasteJsonSchema.safeParse(json);
  if (!parsed.success) throw bad('invalid invite code');
  const payload: InvitePayload = { addresses: parsed.data.h, serverKeyId: parsed.data.k };
  if (parsed.data.i !== undefined) payload.inviteCode = parsed.data.i;
  if (parsed.data.n !== undefined) payload.name = parsed.data.n;
  return normalizePayload(payload);
}

function parseWebLink(s: string): InvitePayload {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad('invalid invite link');
  }
  const marker = `#${CRYPTO_LABELS.pastePrefix}`;
  if (!url.hash.startsWith(marker)) throw bad('link does not contain a GhostLink invite');
  return parsePasteCode(url.hash.slice(1));
}

/**
 * Accepts everything a person may paste into "Join": a ghostlink:// link,
 * a GL1- paste code, a web link with a #GL1- fragment, or a bare host[:port]
 * (TOFU flow). Throws ProtocolError('BAD_REQUEST') on anything else.
 */
export function parseJoinInput(input: string): ParsedJoinInput {
  if (typeof input !== 'string') throw bad('invalid input');
  const s = input.trim();
  if (s.length === 0 || s.length > LIMITS.inviteMaxLength) throw bad('invalid input');
  const lower = s.toLowerCase();
  if (lower.startsWith(`${CRYPTO_LABELS.scheme}:`)) return { kind: 'invite', invite: parseInviteLink(s) };
  if (s.startsWith(CRYPTO_LABELS.pastePrefix)) return { kind: 'invite', invite: parsePasteCode(s) };
  if (lower.startsWith('https://') || lower.startsWith('http://')) return { kind: 'invite', invite: parseWebLink(s) };
  const { host, port } = parseHostPort(s);
  return { kind: 'address', address: formatHostPort(host, port) };
}
```

- [ ] **Step 4: Export it from `index.ts` (final version)**

Replace `packages/shared/src/index.ts` with:

```ts
export * from './constants.js';
export * from './errors.js';
export * from './encoding.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './auth.js';
export * from './fingerprint.js';
export * from './invite.js';
export * from './text.js';
export * from './version.js';
```

- [ ] **Step 5: Run the whole shared suite, typecheck and lint**

Run:
```bash
npm test -- packages/shared
npm run typecheck -w @ghostlink/shared
npx eslint packages
```
Expected: PASS — `Test Files  9 passed (9)`, `Tests  193 passed (193)`; `tsc` and ESLint print no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/invite.ts packages/shared/src/index.ts packages/shared/test/invite.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add invite link, paste code and join input parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---


### Task 8: Server base modules — limits, logger, version, data-dir layout

**Files:**
- Create: `apps/server/src/limits.ts`, `apps/server/src/logger.ts`, `apps/server/src/version.ts`, `apps/server/src/config/paths.ts`
- Test: `apps/server/test/paths.test.ts`

`config/paths.ts` owns the data-dir layout (`tls/`, `ghostlink.db`, `setup-code.txt`, `backups/`) and the rule that secrets are written atomically with mode 0600 (spec §7). POSIX-mode assertions are skipped on Windows, where modes do not apply.

- [ ] **Step 1: Write the failing test**

`apps/server/test/paths.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, ensureDataDirs, writeFileAtomic, writeSecretFile } from '../src/config/paths.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-paths-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('data dir layout', () => {
  it('maps every file to its fixed place', () => {
    const p = dataPaths(dir);
    expect(p.db).toBe(join(dir, 'ghostlink.db'));
    expect(p.certFile).toBe(join(dir, 'tls', 'server.crt'));
    expect(p.keyFile).toBe(join(dir, 'tls', 'server.key'));
    expect(p.setupCodeFile).toBe(join(dir, 'setup-code.txt'));
    expect(p.backupsDir).toBe(join(dir, 'backups'));
  });

  it('creates missing directories, including nested parents', () => {
    const nested = join(dir, 'a', 'b');
    const p = ensureDataDirs(nested);
    expect(statSync(p.tlsDir).isDirectory()).toBe(true);
    expect(statSync(p.backupsDir).isDirectory()).toBe(true);
    expect(() => ensureDataDirs(nested)).not.toThrow();
  });
});

describe('atomic writes', () => {
  it('replaces the content and leaves no temp file behind', () => {
    const file = join(dir, 'x.txt');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['x.txt']);
  });

  it.skipIf(process.platform === 'win32')('writes secrets with mode 0600 even over a 0644 file', () => {
    const file = join(dir, 'secret.txt');
    writeFileAtomic(file, 'public', 0o644);
    writeSecretFile(file, 'secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates data directories as 0700', () => {
    const p = ensureDataDirs(join(dir, 'fresh'));
    expect(statSync(p.root).mode & 0o777).toBe(0o700);
    expect(statSync(p.tlsDir).mode & 0o777).toBe(0o700);
  });

  it('does not leave a temp file when the target directory is missing', () => {
    expect(() => writeFileAtomic(join(dir, 'missing', 'x.txt'), 'x')).toThrow();
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/paths.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/config/paths.js'`.

- [ ] **Step 3: Implement `config/paths.ts`**

```ts
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  tlsDir: string;
  certFile: string;
  keyFile: string;
  setupCodeFile: string;
  backupsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const tlsDir = join(dataDir, 'tls');
  return {
    root: dataDir,
    db: join(dataDir, 'ghostlink.db'),
    tlsDir,
    certFile: join(tlsDir, 'server.crt'),
    keyFile: join(tlsDir, 'server.key'),
    setupCodeFile: join(dataDir, 'setup-code.txt'),
    backupsDir: join(dataDir, 'backups'),
  };
}

/** Creates the data directory tree (0700 on POSIX) and returns its paths. */
export function ensureDataDirs(dataDir: string): DataPaths {
  const p = dataPaths(dataDir);
  for (const dir of [p.root, p.tlsDir, p.backupsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return p;
}

/**
 * Writes via a temp file + rename so a crash never leaves a half-written file.
 * `mode` is applied on POSIX; Windows ignores POSIX modes.
 */
export function writeFileAtomic(path: string, content: string, mode = 0o644): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode });
    if (process.platform !== 'win32') chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Secrets (TLS key, setup code) are readable by the owner only: 0600 (spec §7). */
export function writeSecretFile(path: string, content: string): void {
  writeFileAtomic(path, content, 0o600);
}
```

- [ ] **Step 4: Create `limits.ts`**

`StartServerOptions.limits` (tests only) overrides these, e.g. a 150 ms hello deadline instead of 5 s:

```ts
import { LIMITS } from '@ghostlink/shared';

/** Mutable copy of the shared LIMITS; tests override a few values through StartServerOptions.limits. */
export type ServerLimits = { -readonly [K in keyof typeof LIMITS]: number };

export function resolveLimits(overrides?: Partial<ServerLimits>): ServerLimits {
  return { ...LIMITS, ...overrides };
}
```

- [ ] **Step 5: Create `logger.ts`**

```ts
export interface Logger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

function line(level: string, msg: string, meta?: object): string {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  return `${new Date().toISOString()} ${level} ${msg}${suffix}`;
}

/** Default logger. Never pass message content, tokens or secrets in `meta` (spec §7). */
export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(line('info', msg, meta)),
  warn: (msg, meta) => console.warn(line('warn', msg, meta)),
  error: (msg, meta) => console.error(line('error', msg, meta)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
```

- [ ] **Step 6: Create `version.ts`**

JSON import attributes (`with { type: 'json' }`) are verified to work under tsc 6 (NodeNext), Vitest, tsx and esbuild (the JSON is inlined in the bundle):

```ts
import pkg from '../package.json' with { type: 'json' };

/** Inlined from apps/server/package.json by every bundler (esbuild, electron-vite, vitest). */
export const SERVER_VERSION: string = pkg.version;

/** Placeholder origin for web invite links; replaced in M9 (single constant). */
export const WEB_SITE_BASE = 'https://ghostlink.invalid';
```

- [ ] **Step 7: Run the test, typecheck and lint**

Run:
```bash
npm test -- apps/server/test/paths.test.ts
npm run typecheck -w @ghostlink/server
npx eslint apps
```
Expected: PASS — `Tests  6 passed (6)` on Linux/macOS (`4 passed | 2 skipped` on Windows); no type or lint errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/limits.ts apps/server/src/logger.ts apps/server/src/version.ts apps/server/src/config/paths.ts apps/server/test/paths.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add data dir layout, logger, limits and version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Password hashing with a concurrency limit

**Files:**
- Create: `apps/server/src/util/semaphore.ts`, `apps/server/src/auth/password.ts`
- Test: `apps/server/test/semaphore.test.ts`, `apps/server/test/password.test.ts`, `apps/server/test/password.concurrency.test.ts`

Spec §3.3/§13: scrypt N=2^14, r=8, p=1, 16-byte salt, compared with `timingSafeEqual`, **at most 2 derivations at once** (scrypt runs on the libuv threadpool that also serves file I/O). Stored format (contract): `scrypt$N$r$p$<salt>$<hash>` (base64url). Verification bounds N/r/p/lengths so a tampered stored hash cannot become a CPU or memory bomb. Passwords are NFKC-normalized before hashing so the same password typed on different keyboards/OSes matches.

The concurrency test replaces `node:crypto.scrypt` with a fake that holds callbacks, so it can *observe* how many derivations are in flight — a timing-free, deterministic check.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/semaphore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../src/util/semaphore.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createSemaphore', () => {
  it('never runs more than `max` tasks at once and starts waiters in FIFO order', async () => {
    const sem = createSemaphore(2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const runs = gates.map((g, i) => sem.run(async () => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await g.promise;
      running--;
      return i;
    }));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(3);
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    gates[2]!.resolve();
    gates[3]!.resolve();
    gates[4]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(sem.active).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a non-positive limit', () => {
    expect(() => createSemaphore(0)).toThrow(RangeError);
    expect(() => createSemaphore(1.5)).toThrow(RangeError);
  });
});
```

`apps/server/test/password.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing (scrypt N=2^14, r=8, p=1)', () => {
  it('uses the documented format and a random 16-byte salt', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    const parts = a.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects near misses', async () => {
    const stored = await hashPassword('Senha-Forte-1');
    expect(await verifyPassword('Senha-Forte-1', stored)).toBe(true);
    for (const wrong of ['senha-forte-1', 'Senha-Forte-1 ', 'Senha-Forte-', '']) {
      expect(await verifyPassword(wrong, stored), wrong).toBe(false);
    }
  });

  it('treats canonically equivalent Unicode passwords as equal (NFKC)', async () => {
    const stored = await hashPassword('café');
    expect(await verifyPassword('café', stored)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['too few fields', 'scrypt$16384$8$1$AAAA'],
    ['N not a power of two', 'scrypt$10000$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['memory bomb N=2^30', 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['CPU bomb p=1000', 'scrypt$16384$8$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['short salt', 'scrypt$16384$8$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['empty hash', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$'],
  ])('fails closed on a malformed stored hash: %s', async (_label, stored) => {
    await expect(verifyPassword('x', stored)).resolves.toBe(false);
  });
});
```

`apps/server/test/password.concurrency.test.ts`:

```ts
import type * as NodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Replace scrypt with a controllable fake so the test can observe how many
// derivations run at the same time. vi.mock is hoisted, so its state must be too.
const calls = vi.hoisted((): Array<() => void> => []);
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof NodeCrypto>();
  return {
    ...real,
    scrypt: (_pw: unknown, _salt: unknown, keylen: number, _opts: unknown, cb: (err: Error | null, key: Buffer) => void) => {
      calls.push(() => cb(null, Buffer.alloc(keylen, 1)));
    },
  };
});

const { PASSWORD_CONCURRENCY, verifyPassword } = await import('../src/auth/password.js');

const tick = () => new Promise((r) => setImmediate(r));

describe('password verification concurrency', () => {
  it(`runs at most ${PASSWORD_CONCURRENCY} scrypt derivations at once (spec §13)`, async () => {
    const stored = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32, 1).toString('base64url')}`;
    const results = Array.from({ length: 6 }, () => verifyPassword('pw', stored));
    await tick();
    expect(calls).toHaveLength(2);
    calls.shift()!();
    await tick();
    expect(calls).toHaveLength(2); // one finished, exactly one more started
    while (calls.length > 0) {
      calls.shift()!();
      await tick();
    }
    expect(await Promise.all(results)).toEqual([true, true, true, true, true, true]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- apps/server/test/semaphore.test.ts apps/server/test/password.test.ts apps/server/test/password.concurrency.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/util/semaphore.js'` / `'../src/auth/password.js'`.

- [ ] **Step 3: Implement `util/semaphore.ts`**

```ts
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

/** FIFO counting semaphore: at most `max` tasks run at once, the rest wait in order. */
export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };
  // Hands the slot straight to the next waiter, so `active` never exceeds `max`.
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
```

- [ ] **Step 4: Implement `auth/password.ts`**

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createSemaphore } from '../util/semaphore.js';

// spec §3.3: scrypt N=2^14, r=8, p=1, 16-byte salt, at most 2 concurrent computations.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_CONCURRENCY = 2;
const scryptSlots = createSemaphore(PASSWORD_CONCURRENCY);

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return scryptSlots.run(() => new Promise<Buffer>((resolve, reject) => {
    // NFKC so the same password typed on different keyboards/OSes hashes identically.
    scrypt(password.normalize('NFKC'), salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  }));
}

/** Returns "scrypt$N$r$p$<salt b64url>$<hash b64url>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** Constant-time comparison; malformed or out-of-bounds stored hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bounds keep a tampered hash from turning verification into a CPU/memory bomb.
  if (!isPowerOfTwo(n) || n > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 4) {
    return false;
  }
  if (128 * n * r > MAX_MEMORY) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < SALT_LENGTH || expected.length < 16 || expected.length > 64) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- apps/server/test/semaphore.test.ts apps/server/test/password.test.ts apps/server/test/password.concurrency.test.ts`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  15 passed (15)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/util/semaphore.ts apps/server/src/auth/password.ts apps/server/test/semaphore.test.ts apps/server/test/password.test.ts apps/server/test/password.concurrency.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add scrypt password hashing with a concurrency limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: TLS certificate and serverKeyId

**Files:**
- Create: `apps/server/src/tls/certificate.ts`
- Test: `apps/server/test/certificate.test.ts`

Spec §3.2 profile (all verified against @peculiar/x509 2.1.0 and a real TLS 1.3 handshake): ECDSA P-256/SHA-256, 16-byte positive random serial, `CN=GhostLink`, `BasicConstraints CA:false` (critical), **`KeyUsage = digitalSignature` (critical)** — without it Electron's BoringSSL refuses the certificate before the pin is ever checked — `EKU serverAuth`, SAN `localhost` + `127.0.0.1`, 10 years (`notBefore` 5 min in the past for clock skew). `serverKeyId = base64url(SHA-256(SPKI DER))`, **never** the raw EC point (`cert.pubkey`) nor the whole-cert hash (`fingerprint256`).

Critical import order: `import 'reflect-metadata'` must be the **first** import of the module that imports `@peculiar/x509`; x509 2.x throws `tsyringe requires a reflect polyfill` otherwise (verified, also in ESM). The same applies to the test file.

`readCertificate` never regenerates when only one of the two files exists: a new key would change the `serverKeyId` and break every pin and invite. It also refuses a key that does not match the certificate.

- [ ] **Step 1: Write the failing test**

`apps/server/test/certificate.test.ts`:

```ts
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataPaths } from '../src/config/paths.js';
import { generateCertificate, loadOrCreateCertificate, readCertificate, serverKeyIdFromDer } from '../src/tls/certificate.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-cert-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('generateCertificate', () => {
  it('has the exact profile BoringSSL and the pin need (spec §3.2)', async () => {
    const { certPem } = await generateCertificate(new Date('2026-01-01T00:00:00Z'));
    const cert = new x509.X509Certificate(certPem);
    expect(cert.subject).toBe('CN=GhostLink');
    expect(cert.issuer).toBe('CN=GhostLink');
    expect(cert.publicKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(cert.signatureAlgorithm).toMatchObject({ name: 'ECDSA', hash: { name: 'SHA-256' } });

    const ku = cert.getExtension(x509.KeyUsagesExtension)!;
    expect(ku.critical).toBe(true);
    expect(ku.usages).toBe(x509.KeyUsageFlags.digitalSignature);
    const bc = cert.getExtension(x509.BasicConstraintsExtension)!;
    expect(bc.ca).toBe(false);
    expect([...cert.getExtension(x509.ExtendedKeyUsageExtension)!.usages]).toEqual([x509.ExtendedKeyUsage.serverAuth]);

    const node = new X509Certificate(certPem);
    expect(node.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
    expect(node.serialNumber).toMatch(/^[0-9A-F]{32}$/); // 16 bytes
    expect(Number.parseInt(node.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80); // positive
    const years = (node.validToDate.getTime() - node.validFromDate.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.99);
    expect(node.validFromDate.getTime()).toBeLessThan(new Date('2026-01-01T00:00:00Z').getTime()); // skew margin
  });

  it('uses a fresh random serial and key every time', async () => {
    const a = new X509Certificate((await generateCertificate()).certPem);
    const b = new X509Certificate((await generateCertificate()).certPem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
    expect(serverKeyIdFromDer(a.raw)).not.toBe(serverKeyIdFromDer(b.raw));
  });
});

describe('serverKeyIdFromDer', () => {
  it('hashes the SPKI DER, not the raw EC point nor the whole certificate', async () => {
    const { certPem } = await generateCertificate();
    const cert = new X509Certificate(certPem);
    const id = serverKeyIdFromDer(cert.raw);
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    expect(id).toBe(createHash('sha256').update(spki).digest('base64url'));
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(createHash('sha256').update(cert.raw).digest('base64url'));
  });
});

describe('loadOrCreateCertificate', () => {
  it('creates the pair once, then reloads the same serverKeyId', async () => {
    const first = await loadOrCreateCertificate(dir);
    const second = await loadOrCreateCertificate(dir);
    expect(second.serverKeyId).toBe(first.serverKeyId);
    expect(second.certPem).toBe(first.certPem);
    expect(readCertificate(dir)?.serverKeyId).toBe(first.serverKeyId);
  });

  it.skipIf(process.platform === 'win32')('stores the private key as 0600', async () => {
    await loadOrCreateCertificate(dir);
    expect(statSync(dataPaths(dir).keyFile).mode & 0o777).toBe(0o600);
  });

  it('serves TLS whose peer SPKI hash equals serverKeyId (what clients pin)', async () => {
    const { certPem, keyPem, serverKeyId } = await loadOrCreateCertificate(dir);
    const server = createServer({ cert: certPem, key: keyPem }, (_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const socket = connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, rejectUnauthorized: false });
    await new Promise<void>((r) => socket.once('secureConnect', () => r()));
    const peer = new X509Certificate(socket.getPeerCertificate(true).raw);
    expect(serverKeyIdFromDer(peer.raw)).toBe(serverKeyId);
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses to regenerate when only one of the two files exists', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ghostlink-cert-half-'));
    try {
      await loadOrCreateCertificate(other);
      unlinkSync(dataPaths(other).certFile);
      await expect(loadOrCreateCertificate(other)).rejects.toThrow(/Incomplete TLS material/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a key that does not match the certificate', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ghostlink-cert-mismatch-'));
    try {
      await loadOrCreateCertificate(other);
      writeFileSync(dataPaths(other).keyFile, (await generateCertificate()).keyPem);
      expect(() => readCertificate(other)).toThrow(/does not match/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/certificate.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/tls/certificate.js'`.

- [ ] **Step 3: Implement `tls/certificate.ts`**

```ts
// reflect-metadata MUST be imported before @peculiar/x509 (2.x throws without the polyfill).
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createHash, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dataPaths, ensureDataDirs, writeFileAtomic, writeSecretFile } from '../config/paths.js';

export interface ServerCertificate {
  certPem: string;
  keyPem: string;
  serverKeyId: string;
}

const EC_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const VALIDITY_YEARS = 10;
const CLOCK_SKEW_MS = 5 * 60_000;

/** serverKeyId = base64url(SHA-256(SPKI DER)) — never the raw EC point, never the whole-cert hash (spec §3.2). */
export function serverKeyIdFromDer(der: Uint8Array): string {
  const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url');
}

/**
 * Self-signed ECDSA P-256 certificate (spec §3.2): 16-byte positive serial,
 * CN=GhostLink, CA:false, KeyUsage=digitalSignature (critical — BoringSSL refuses
 * the cert otherwise), EKU serverAuth, SAN localhost/127.0.0.1, 10-year validity.
 */
export async function generateCertificate(now: Date = new Date()): Promise<{ certPem: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify']);
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive and exactly 16 bytes in DER
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_MS);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: 'CN=GhostLink',
    notBefore,
    notAfter,
    signingAlgorithm: EC_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
      ], false),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  return { certPem: cert.toString('pem'), keyPem };
}

/** Reads data/tls/server.{crt,key}. Returns null when neither exists; throws when only one does or they do not match. */
export function readCertificate(dataDir: string): ServerCertificate | null {
  const p = dataPaths(dataDir);
  const hasCert = existsSync(p.certFile);
  const hasKey = existsSync(p.keyFile);
  if (!hasCert && !hasKey) return null;
  if (hasCert !== hasKey) {
    // Never regenerate here: a new key would change the serverKeyId and break every pin and invite.
    throw new Error(`Incomplete TLS material in ${p.tlsDir}: server.crt and server.key must both exist. Restore them from a backup.`);
  }
  const certPem = readFileSync(p.certFile, 'utf8');
  const keyPem = readFileSync(p.keyFile, 'utf8');
  const cert = new X509Certificate(certPem);
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error(`TLS key in ${p.keyFile} does not match ${p.certFile}.`);
  }
  return { certPem, keyPem, serverKeyId: serverKeyIdFromDer(cert.raw) };
}

export async function loadOrCreateCertificate(dataDir: string): Promise<ServerCertificate> {
  const existing = readCertificate(dataDir);
  if (existing) return existing;
  const p = ensureDataDirs(dataDir);
  const generated = await generateCertificate();
  writeSecretFile(p.keyFile, generated.keyPem);
  writeFileAtomic(p.certFile, generated.certPem);
  const created = readCertificate(dataDir);
  if (!created) throw new Error('certificate vanished right after being written');
  return created;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- apps/server/test/certificate.test.ts`
Expected: PASS — `Tests  8 passed (8)` (`7 passed | 1 skipped` on Windows).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tls/certificate.ts apps/server/test/certificate.test.ts
git commit -m "$(cat <<'EOF'
feat(server): generate and load the pinned TLS certificate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: SQLite wrapper and migration 001

**Files:**
- Create: `apps/server/src/db/database.ts`, `apps/server/src/db/migrations/001_init.sql`
- Test: `apps/server/test/database.test.ts`

Spec §7: `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000; secure_delete=ON`; numbered SQL migrations tracked by `PRAGMA user_version`, each in its own transaction; before migrating a non-empty database, `VACUUM INTO backups/ghostlink-v<N>.db` keeping the 3 newest; a database with a newer `user_version` is refused with an explanation. Verified on Node 24.14: `node:sqlite` returns rows as null-prototype objects and BLOBs as `Uint8Array`; `VACUUM INTO ?` accepts a bound path; `isTransaction` exists; `PRAGMA user_version` is rolled back with its transaction.

`Db.tx` uses `BEGIN IMMEDIATE` and **throws if the callback returns a Promise** — an `await` inside the admission transaction would reintroduce the race spec §3.5 forbids, so the wrapper makes that mistake impossible. Migrations are read at runtime from `new URL('./migrations/', import.meta.url)`; the esbuild bundle (Task 24) copies them to `dist/migrations/`.

Tables are `STRICT` (typed columns) and carry the spec §7 constraints (`CHECK (id = 1)`, join-mode enum, `UNIQUE` public key and nickname, positive `max_uses`).

- [ ] **Step 1: Write the failing test**

`apps/server/test/database.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db, DatabaseTooNewError, loadMigrations, type Migration } from '../src/db/database.js';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-db-'));
  dbPath = join(dir, 'ghostlink.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const m = (version: number, sql: string): Migration => ({ version, name: `m${version}`, sql });

describe('Db basics', () => {
  it('opens in WAL mode with foreign keys, busy timeout and secure_delete', () => {
    const db = new Db(dbPath);
    expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(db.get('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
    expect(db.get('PRAGMA secure_delete')).toEqual({ secure_delete: 1 });
    db.close();
  });

  it('returns BLOBs as Uint8Array and reports changes', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (k BLOB, v INTEGER)');
    expect(db.run('INSERT INTO t VALUES (?, ?)', new Uint8Array([1, 2, 3]), 7)).toEqual({ changes: 1, lastInsertRowid: 1 });
    const row = db.get<{ k: Uint8Array; v: number }>('SELECT * FROM t WHERE k = ?', new Uint8Array([1, 2, 3]));
    expect(row?.k).toBeInstanceOf(Uint8Array);
    expect(Array.from(row!.k)).toEqual([1, 2, 3]);
    expect(db.all('SELECT v FROM t')).toEqual([{ v: 7 }]);
    db.close();
  });
});

describe('Db.tx', () => {
  it('commits on success and rolls back on throw', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    db.tx(() => db.run('INSERT INTO t VALUES (1)'));
    expect(() => db.tx(() => {
      db.run('INSERT INTO t VALUES (2)');
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('refuses an async callback and rolls back its synchronous part', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    expect(() => db.tx(async () => {
      db.run('INSERT INTO t VALUES (1)');
    })).toThrow(/must be synchronous/);
    expect(db.all('SELECT v FROM t')).toEqual([]);
    db.close();
  });

  it('refuses nesting', () => {
    const db = new Db(dbPath);
    expect(() => db.tx(() => db.tx(() => 1))).toThrow(/nested/);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('is exclusive against a second connection (BEGIN IMMEDIATE)', () => {
    const a = new Db(dbPath);
    const b = new Db(dbPath);
    a.exec('CREATE TABLE t (v INTEGER)');
    b.exec('PRAGMA busy_timeout = 0');
    a.tx(() => {
      a.run('INSERT INTO t VALUES (1)');
      expect(() => b.tx(() => b.run('INSERT INTO t VALUES (2)'))).toThrow(/locked|busy/i);
    });
    expect(a.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
    a.close();
    b.close();
  });
});

describe('migrations', () => {
  it('the real migration set starts at 001 and creates the M1 tables', () => {
    const migrations = loadMigrations();
    expect(migrations[0]).toMatchObject({ version: 1, name: 'init' });
    const db = new Db(dbPath);
    db.migrate();
    expect(db.userVersion).toBe(migrations.length);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['bans', 'invites', 'server_meta', 'users']));
    db.close();
  });

  it('enforces the spec §7 constraints', () => {
    const db = new Db(dbPath);
    db.migrate();
    db.run("INSERT INTO server_meta (id, name, created_at) VALUES (1, 'S', 0)");
    expect(() => db.run("INSERT INTO server_meta (id, name, created_at) VALUES (2, 'S', 0)")).toThrow();
    expect(() => db.run("UPDATE server_meta SET join_mode = 'closed'")).toThrow();
    expect(db.get('SELECT join_mode, max_members FROM server_meta')).toEqual({ join_mode: 'invite', max_members: 100 });
    db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('a', x'01', 'A', 'a', 0)");
    expect(() => db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('b', x'01', 'B', 'b', 0)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('c', x'02', 'A', 'a', 0)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO invites (code, created_at, max_uses) VALUES ('X', 0, 0)")).toThrow();
    db.close();
  });

  it('is idempotent and does not back up a fresh database', () => {
    const db = new Db(dbPath);
    db.migrate();
    db.migrate();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    db.close();
  });

  it('backs up with VACUUM INTO before upgrading an existing database', () => {
    const db = new Db(dbPath);
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);')]);
    db.run('INSERT INTO t VALUES (42)');
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);'), m(2, 'ALTER TABLE t ADD COLUMN w INTEGER;')]);
    expect(db.userVersion).toBe(2);
    db.close();
    const backup = new Db(join(dir, 'backups', 'ghostlink-v1.db'));
    expect(backup.userVersion).toBe(1);
    expect(backup.all('SELECT * FROM t')).toEqual([{ v: 42 }]);
    backup.close();
  });

  it('keeps only the 3 most recent backups', () => {
    const db = new Db(dbPath);
    const all = [1, 2, 3, 4, 5].map((v) => m(v, `CREATE TABLE t${v} (v INTEGER);`));
    db.migrate(all.slice(0, 1));
    for (let n = 2; n <= 5; n++) db.migrate(all.slice(0, n));
    db.close();
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual(['ghostlink-v2.db', 'ghostlink-v3.db', 'ghostlink-v4.db']);
  });

  it('rolls back a failing migration completely, including user_version', () => {
    const db = new Db(dbPath);
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);')]);
    expect(() => db.migrate([m(1, 'CREATE TABLE t (v INTEGER);'), m(2, 'CREATE TABLE u (v INTEGER); THIS IS NOT SQL;')])).toThrow();
    expect(db.userVersion).toBe(1);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'u'")).toBeUndefined();
    db.close();
  });

  it('refuses a database written by a newer server', () => {
    const db = new Db(dbPath);
    db.exec('PRAGMA user_version = 99');
    expect(() => db.migrate()).toThrow(DatabaseTooNewError);
    try {
      db.migrate();
    } catch (e) {
      expect((e as DatabaseTooNewError).found).toBe(99);
      expect((e as Error).message).toMatch(/newer GhostLink/);
    }
    expect(db.userVersion).toBe(99);
    db.close();
  });

  it('rejects gaps in migration numbering', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ghostlink-mig-'));
    try {
      writeFileSync(join(tmp, '001_a.sql'), 'SELECT 1;');
      writeFileSync(join(tmp, '003_c.sql'), 'SELECT 1;');
      expect(() => loadMigrations(pathToFileURL(`${tmp}/`))).toThrow(/without gaps/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/database.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/db/database.js'`.

- [ ] **Step 3: Create `db/migrations/001_init.sql`**

```sql
-- Milestone 1 schema (spec §7). Later milestones add 002_*.sql and never edit this file.

CREATE TABLE server_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  icon_file_id TEXT,
  join_mode TEXT NOT NULL DEFAULT 'invite' CHECK (join_mode IN ('open', 'password', 'invite')),
  password_hash TEXT,
  owner_user_id TEXT,
  setup_code_hash TEXT,
  public_addresses TEXT NOT NULL DEFAULT '[]',
  max_members INTEGER NOT NULL DEFAULT 100 CHECK (max_members > 0),
  upload_limit_mb INTEGER NOT NULL DEFAULT 25,
  storage_quota_mb INTEGER NOT NULL DEFAULT 10240,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  nickname_norm TEXT NOT NULL UNIQUE,
  avatar_file_id TEXT,
  locale TEXT,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip TEXT,
  removed_at INTEGER,
  rejoin_blocked_until INTEGER
) STRICT;

CREATE TABLE bans (
  user_id TEXT PRIMARY KEY,
  public_key BLOB,
  ip TEXT,
  reason TEXT,
  banned_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX bans_public_key ON bans(public_key);
CREATE INDEX bans_ip ON bans(ip) WHERE ip IS NOT NULL;

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) STRICT;
```

- [ ] **Step 4: Implement `db/database.ts`**

```ts
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';

export type SqlParam = SQLInputValue;
export type Row = Record<string, SQLOutputValue>;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class DatabaseTooNewError extends Error {
  constructor(
    public readonly found: number,
    public readonly supported: number,
  ) {
    super(`The database schema is v${found}, but this GhostLink server only knows up to v${supported}. `
      + 'It was written by a newer GhostLink version: update GhostLink, or restore a backup from the backups/ folder.');
    this.name = 'DatabaseTooNewError';
  }
}

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const BACKUPS_TO_KEEP = 3;

/**
 * Reads NNN_name.sql files next to this module (src/db/migrations in dev,
 * dist/migrations in the esbuild bundle, which copies them).
 */
export function loadMigrations(dir: URL = new URL('./migrations/', import.meta.url)): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((x): x is { file: string; match: RegExpExecArray } => x.match !== null)
    .map(({ file, match }) => ({
      version: Number(match[1]),
      name: match[2]!,
      sql: readFileSync(new URL(file, dir), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 001, 002, … without gaps (found ${m.version})`);
  });
  return migrations;
}

/**
 * Thin wrapper over node:sqlite (spec §7). Rows come back as null-prototype
 * objects and BLOBs as Uint8Array; compare keys in SQL or with Buffer.compare.
 */
export class Db {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  }

  get userVersion(): number {
    return Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  /**
   * Applies pending migrations, each in its own transaction. Backs up a non-empty
   * database first (VACUUM INTO backups/ghostlink-v<N>.db, keeping the 3 newest)
   * and refuses a database written by a newer server.
   */
  migrate(migrations: readonly Migration[] = loadMigrations()): void {
    const supported = migrations.at(-1)?.version ?? 0;
    const current = this.userVersion;
    if (current > supported) throw new DatabaseTooNewError(current, supported);
    if (current === supported) return;
    if (current > 0) this.#backup(current);
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.#db.exec(m.sql);
        this.#db.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
  }

  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT. `fn` must be synchronous: an
   * `await` inside would let other connections interleave (spec §3.5), so a
   * returned promise rolls the transaction back and throws.
   */
  tx<T>(fn: () => T): T {
    if (this.#db.isTransaction) throw new Error('nested Db.tx is not supported');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch(() => {});
        throw new Error('Db.tx callback must be synchronous');
      }
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  get<T extends object = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T extends object = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.#prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#statements.clear();
    if (this.#db.isOpen) this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #backup(version: number): void {
    const dir = join(dirname(this.path), 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `ghostlink-v${version}.db`);
    rmSync(target, { force: true }); // VACUUM INTO refuses to overwrite
    this.#db.prepare('VACUUM INTO ?').run(target);
    const old = readdirSync(dir)
      .map((f) => ({ f, v: /^ghostlink-v(\d+)\.db$/.exec(f)?.[1] }))
      .filter((x): x is { f: string; v: string } => x.v !== undefined)
      .sort((a, b) => Number(b.v) - Number(a.v))
      .slice(BACKUPS_TO_KEEP);
    for (const { f } of old) rmSync(join(dir, f), { force: true });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- apps/server/test/database.test.ts`
Expected: PASS — `Tests  14 passed (14)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/database.ts apps/server/src/db/migrations/001_init.sql apps/server/test/database.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add SQLite wrapper with backed-up migrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Server metadata and the owner setup code

**Files:**
- Create: `apps/server/src/db/serverMeta.ts`, `apps/server/src/auth/setupCode.ts`
- Test: `apps/server/test/setupCode.test.ts`

Spec §3.3 "Dono": on first run the server creates a 128-bit setup code, shown as 4 groups (here: 8 hex digits each, `3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718`), written to `data/setup-code.txt` (0600) while the DB keeps only its SHA-256. A `hello` with the valid code makes that identity the owner; the code is consumed in the same transaction that writes `owner_user_id` (one `UPDATE … WHERE setup_code_hash = ?`, so two concurrent uses cannot both win) and the file is deleted. If the file is lost or edited while no owner exists, the code is rotated (the old one can never be shown again). `checkSetupCode` is a side-effect-free pre-check used before the transaction.

- [ ] **Step 1: Write the failing test**

`apps/server/test/setupCode.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkSetupCode,
  consumeSetupCode,
  ensureSetupCode,
  generateSetupCode,
  normalizeSetupCode,
  resetSetupCode,
} from '../src/auth/setupCode.js';
import { dataPaths, ensureDataDirs } from '../src/config/paths.js';
import { Db } from '../src/db/database.js';
import { ensureMeta, getMeta } from '../src/db/serverMeta.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-setup-'));
  db = new Db(ensureDataDirs(dir).db);
  db.migrate();
  ensureMeta(db, { name: 'S', joinMode: 'invite', now: 0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('setup code format', () => {
  it('is 128 random bits in 4 groups of 8 hex digits', () => {
    const code = generateSetupCode();
    expect(code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(generateSetupCode()).not.toBe(code);
  });

  it('normalizes case, spaces and dashes', () => {
    expect(normalizeSetupCode(' 3F9A2B1C 7d4e5f60-A1B2C3D4-e5f60718 ')).toBe('3f9a2b1c7d4e5f60a1b2c3d4e5f60718');
    expect(normalizeSetupCode('3f9a2b1c-7d4e5f60-a1b2c3d4')).toBeNull();
    expect(normalizeSetupCode('zzzzzzzz-7d4e5f60-a1b2c3d4-e5f60718')).toBeNull();
  });
});

describe('ensureSetupCode', () => {
  it('creates a code on first run, stores only its hash and writes the file', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(readFileSync(dataPaths(dir).setupCodeFile, 'utf8').trim()).toBe(code);
    const { setupCodeHash } = getMeta(db);
    expect(setupCodeHash).not.toBeNull();
    expect(setupCodeHash).not.toContain(normalizeSetupCode(code)!);
    expect(ensureSetupCode(db, dir)).toBe(code); // stable across restarts
  });

  it.skipIf(process.platform === 'win32')('writes the file as 0600', () => {
    ensureSetupCode(db, dir);
    expect(statSync(dataPaths(dir).setupCodeFile).mode & 0o777).toBe(0o600);
  });

  it('rotates the code when the file was lost or tampered with', () => {
    const first = ensureSetupCode(db, dir)!;
    rmSync(dataPaths(dir).setupCodeFile);
    const second = ensureSetupCode(db, dir)!;
    expect(second).not.toBe(first);
    expect(checkSetupCode(db, first)).toBe(false);
    writeFileSync(dataPaths(dir).setupCodeFile, 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa\n');
    const third = ensureSetupCode(db, dir)!;
    expect(third).not.toBe('aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa');
    expect(checkSetupCode(db, third)).toBe(true);
  });

  it('returns null once the server has an owner', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(db.tx(() => consumeSetupCode(db, dir, code, 'u1'))).toBe(true);
    expect(ensureSetupCode(db, dir)).toBeNull();
  });
});

describe('consumeSetupCode', () => {
  it('makes the user owner, burns the code and deletes the file', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(consumeSetupCode(db, dir, code.toUpperCase(), 'owner-1')).toBe(true);
    expect(getMeta(db)).toMatchObject({ ownerUserId: 'owner-1', setupCodeHash: null });
    expect(existsSync(dataPaths(dir).setupCodeFile)).toBe(false);
    expect(consumeSetupCode(db, dir, code, 'owner-2')).toBe(false);
    expect(getMeta(db).ownerUserId).toBe('owner-1');
  });

  it('rejects a wrong or malformed code without side effects', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(consumeSetupCode(db, dir, generateSetupCode(), 'x')).toBe(false);
    expect(consumeSetupCode(db, dir, 'nope', 'x')).toBe(false);
    expect(getMeta(db).ownerUserId).toBeNull();
    expect(checkSetupCode(db, code)).toBe(true);
  });

  it('resetSetupCode invalidates the previous code', () => {
    const old = ensureSetupCode(db, dir)!;
    const fresh = resetSetupCode(db, dir);
    expect(checkSetupCode(db, old)).toBe(false);
    expect(checkSetupCode(db, fresh)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/setupCode.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/setupCode.js'`.

- [ ] **Step 3: Implement `db/serverMeta.ts`**

```ts
import type { JoinMode } from '@ghostlink/shared';
import type { Db } from './database.js';

export interface ServerMeta {
  name: string;
  joinMode: JoinMode;
  passwordHash: string | null;
  ownerUserId: string | null;
  setupCodeHash: string | null;
  publicAddresses: string[];
  maxMembers: number;
  createdAt: number;
}

interface MetaRow {
  name: string;
  join_mode: JoinMode;
  password_hash: string | null;
  owner_user_id: string | null;
  setup_code_hash: string | null;
  public_addresses: string;
  max_members: number;
  created_at: number;
}

function parseAddresses(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function getMeta(db: Db): ServerMeta {
  const row = db.get<MetaRow>('SELECT * FROM server_meta WHERE id = 1');
  if (!row) throw new Error('server_meta is missing; call ensureMeta first');
  return {
    name: row.name,
    joinMode: row.join_mode,
    passwordHash: row.password_hash,
    ownerUserId: row.owner_user_id,
    setupCodeHash: row.setup_code_hash,
    publicAddresses: parseAddresses(row.public_addresses),
    maxMembers: Number(row.max_members),
    createdAt: Number(row.created_at),
  };
}

/** Seeds the single server_meta row on first run; later runs keep the stored name and join mode. */
export function ensureMeta(db: Db, init: { name: string; joinMode: JoinMode; now: number }): ServerMeta {
  db.run('INSERT OR IGNORE INTO server_meta (id, name, join_mode, created_at) VALUES (1, ?, ?, ?)', init.name, init.joinMode, init.now);
  return getMeta(db);
}

export function setPublicAddresses(db: Db, addresses: readonly string[]): void {
  db.run('UPDATE server_meta SET public_addresses = ? WHERE id = 1', JSON.stringify(addresses));
}
```

- [ ] **Step 4: Implement `auth/setupCode.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dataPaths, writeSecretFile } from '../config/paths.js';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';

const NORMALIZED = /^[0-9a-f]{32}$/;

/** 128 random bits shown as 4 groups of 8 hex digits: "3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718". */
export function generateSetupCode(): string {
  const hex = randomBytes(16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)].join('-');
}

/** Accepts any case, spaces and dashes; returns the 32 hex digits or null. */
export function normalizeSetupCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  return NORMALIZED.test(s) ? s : null;
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('base64url');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Issues a fresh code: the DB keeps only its hash, the plain code goes to data/setup-code.txt (0600). */
export function resetSetupCode(db: Db, dataDir: string): string {
  const code = generateSetupCode();
  db.run('UPDATE server_meta SET setup_code_hash = ? WHERE id = 1', hashCode(normalizeSetupCode(code)!));
  writeSecretFile(dataPaths(dataDir).setupCodeFile, `${code}\n`);
  return code;
}

/**
 * Returns the current setup code, creating one when the server has no owner yet.
 * Returns null once the code was consumed (the server has an owner and no pending code).
 */
export function ensureSetupCode(db: Db, dataDir: string): string | null {
  const meta = getMeta(db);
  if (meta.setupCodeHash === null) {
    return meta.ownerUserId === null ? resetSetupCode(db, dataDir) : null;
  }
  const file = dataPaths(dataDir).setupCodeFile;
  if (existsSync(file)) {
    const code = readFileSync(file, 'utf8').trim();
    const normalized = normalizeSetupCode(code);
    if (normalized !== null && sameHash(hashCode(normalized), meta.setupCodeHash)) return code;
  }
  // The file was lost or edited: the old code can never be shown again, so rotate it.
  return resetSetupCode(db, dataDir);
}

/** True when `code` matches the pending setup code (does not consume it). */
export function checkSetupCode(db: Db, code: string): boolean {
  const normalized = normalizeSetupCode(code);
  const { setupCodeHash } = getMeta(db);
  return normalized !== null && setupCodeHash !== null && sameHash(hashCode(normalized), setupCodeHash);
}

/**
 * Makes `userId` the owner and burns the code in one UPDATE guarded by the
 * current hash, so two concurrent uses cannot both succeed. Deletes the file.
 * Call it inside the admission transaction.
 */
export function consumeSetupCode(db: Db, dataDir: string, code: string, userId: string): boolean {
  if (!checkSetupCode(db, code)) return false;
  const { setupCodeHash } = getMeta(db);
  const r = db.run(
    'UPDATE server_meta SET owner_user_id = ?, setup_code_hash = NULL WHERE id = 1 AND setup_code_hash = ?',
    userId,
    setupCodeHash,
  );
  if (r.changes !== 1) return false;
  rmSync(dataPaths(dataDir).setupCodeFile, { force: true });
  return true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- apps/server/test/setupCode.test.ts`
Expected: PASS — `Tests  9 passed (9)` (`8 passed | 1 skipped` on Windows).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/serverMeta.ts apps/server/src/auth/setupCode.ts apps/server/test/setupCode.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add server metadata and owner setup code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Identity verification (Ed25519) and the test identity helper

**Files:**
- Create: `apps/server/src/auth/identity.ts`, `apps/server/test/helpers/identity.ts`
- Test: `apps/server/test/identity.test.ts`

Spec §3.2: `userId = hex(SHA-256(raw 32-byte public key))[0:32]`; the client's raw key is imported as an OKP JWK and checked with `crypto.verify(null, …)`.

**Security finding (verified on Node 24.14 / OpenSSL 3.5):** OpenSSL accepts forged signatures for *small-order* Ed25519 public keys. With the all-zero public key, the all-zero signature verifies for the exact auth message used in the test below. Nobody holds a private key for such a "key", so any attacker could log in as that identity. `identity.ts` therefore rejects the 7 small-order encodings (sign bit masked) — the same blocklist libsodium uses — and the handshake refuses them at `hello` (Task 19). Keys derived from real seeds never hit the blocklist.

The test identity helper builds keys exactly like the desktop (spec §3.2: PKCS#8 prefix `302e020100300506032b657004220420` + 32-byte seed). The known-answer vector pins that derivation.

- [ ] **Step 1: Create the test identity helper**

`apps/server/test/helpers/identity.ts`:

```ts
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface TestIdentity {
  seed: Uint8Array;
  publicKeyRaw: Uint8Array;
  publicKey: string; // base64url
  userId: string;
  sign(message: Uint8Array): Uint8Array;
}

/** Ed25519 identity from a 32-byte seed, built exactly like the desktop does (spec §3.2). */
export function makeIdentity(seed: Uint8Array = randomBytes(32)): TestIdentity {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKeyRaw = Buffer.from(jwk.x!, 'base64url');
  return {
    seed,
    publicKeyRaw,
    publicKey: jwk.x!,
    userId: createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 32),
    sign: (message) => sign(null, message, privateKey),
  };
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/test/identity.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProtocolError, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import { isWeakPublicKey, userIdFromPublicKey, verifyAuthSignature } from '../src/auth/identity.js';
import { makeIdentity } from './helpers/identity.js';

const KEY_ID = toBase64Url(new Uint8Array(32).fill(9));
const NONCE = toBase64Url(new Uint8Array(32).fill(4));

describe('userIdFromPublicKey', () => {
  it('is the first 32 hex chars (128 bits) of SHA-256(raw key)', () => {
    const id = makeIdentity(new Uint8Array(32).fill(1));
    const expected = createHash('sha256').update(id.publicKeyRaw).digest('hex').slice(0, 32);
    expect(userIdFromPublicKey(id.publicKeyRaw)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => userIdFromPublicKey(new Uint8Array(31))).toThrow(ProtocolError);
  });
});

describe('verifyAuthSignature', () => {
  const id = makeIdentity(new Uint8Array(32).fill(2));
  const message = buildAuthMessage(KEY_ID, NONCE);
  const signature = id.sign(message);

  it('matches a known-answer vector (seed 0x02×32, PKCS#8 prefix from spec §3.2)', () => {
    // Ed25519 is deterministic: a change here means desktop and server disagree on key derivation.
    expect(id.publicKey).toBe('gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q');
    expect(Buffer.from(signature).toString('base64url'))
      .toBe('96sonYXPGBB46leSsN_GzWb2S3nqAdeTWpzo9I66DsLE2flRlj9WUm699OUv4wBWNkRRjrg6XTPr022gYEG6Dw');
    expect(verifyAuthSignature(id.publicKeyRaw, message, signature)).toBe(true);
  });

  it('rejects a signature over another serverKeyId (proof relayed to a different server)', () => {
    const otherServer = buildAuthMessage(toBase64Url(new Uint8Array(32).fill(8)), NONCE);
    expect(verifyAuthSignature(id.publicKeyRaw, otherServer, signature)).toBe(false);
  });

  it('rejects a signature by another key, a flipped bit, and wrong lengths', () => {
    const other = makeIdentity(new Uint8Array(32).fill(3));
    expect(verifyAuthSignature(other.publicKeyRaw, message, signature)).toBe(false);
    const flipped = Uint8Array.from(signature);
    flipped[10]! ^= 1;
    expect(verifyAuthSignature(id.publicKeyRaw, message, flipped)).toBe(false);
    expect(verifyAuthSignature(id.publicKeyRaw, message, signature.subarray(0, 63))).toBe(false);
    expect(verifyAuthSignature(id.publicKeyRaw.subarray(0, 31), message, signature)).toBe(false);
  });

  it('rejects the all-zero key even with a forged all-zero signature that OpenSSL alone would accept', () => {
    // For this exact message, crypto.verify(zero key, zero signature) returns true:
    // the zero key is a small-order point, so the blocklist is what stops it.
    expect(verifyAuthSignature(new Uint8Array(32), message, new Uint8Array(64))).toBe(false);
  });
});

describe('isWeakPublicKey', () => {
  it('flags every small-order encoding, with or without the sign bit', () => {
    const hex = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const h of hex) {
      const key = Buffer.from(h, 'hex');
      expect(isWeakPublicKey(key), h).toBe(true);
      key[31]! |= 0x80;
      expect(isWeakPublicKey(key), `${h} with sign bit`).toBe(true);
    }
  });

  it('accepts real keys', () => {
    for (let i = 0; i < 20; i++) expect(isWeakPublicKey(makeIdentity().publicKeyRaw)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- apps/server/test/identity.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/identity.js'`.

- [ ] **Step 4: Implement `auth/identity.ts`**

```ts
import { createHash, createPublicKey, verify } from 'node:crypto';
import { ProtocolError } from '@ghostlink/shared';

/**
 * Encodings of the 8 small-order Ed25519 points (plus non-canonical twins),
 * compared with the sign bit cleared — the same blocklist libsodium uses.
 * With such a "public key" nobody holds a private key, yet some forged
 * signatures (e.g. all zeros) verify for a fraction of messages.
 */
const SMALL_ORDER_KEYS: readonly Buffer[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));

export function isWeakPublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return true;
  const masked = Buffer.from(raw);
  masked[31]! &= 0x7f;
  return SMALL_ORDER_KEYS.some((k) => k.equals(masked));
}

/** userId = hex(SHA-256(raw 32-byte Ed25519 public key))[0:32] — 128 bits (spec §3.2). */
export function userIdFromPublicKey(raw: Uint8Array): string {
  if (raw.length !== 32) throw new ProtocolError('BAD_REQUEST', 'public key must be 32 bytes');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Ed25519 verification of a raw 32-byte public key (imported as an OKP JWK). Never throws. */
export function verifyAuthSignature(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKeyRaw.length !== 32 || signature.length !== 64 || isWeakPublicKey(publicKeyRaw)) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyRaw).toString('base64url') },
      format: 'jwk',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- apps/server/test/identity.test.ts`
Expected: PASS — `Tests  8 passed (8)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/identity.ts apps/server/test/helpers/identity.ts apps/server/test/identity.test.ts
git commit -m "$(cat <<'EOF'
feat(server): verify Ed25519 auth proofs and reject small-order keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Challenge store and sliding-window rate limiter

**Files:**
- Create: `apps/server/src/auth/challenges.ts`, `apps/server/src/ratelimit/limiter.ts`
- Test: `apps/server/test/challenges.test.ts`, `apps/server/test/limiter.test.ts`

`ChallengeStore` (spec §3.3/§13): one 32-byte nonce per connection, **single use** (`take` removes it), expiring `ttlMs` after issue **according to the injected clock**, and at most `pendingChallengesPerIp` outstanding per IP key. `SlidingWindowLimiter(limit, windowMs, now)`: `hit` records only allowed hits, `peek` never records (used to check the auth-failure budget without spending it), `sweep` bounds memory. `ipKey` groups IPv6 by /64 (one subscriber usually owns a whole /64), maps IPv4-mapped IPv6 to IPv4 and strips zone ids and brackets; it canonicalizes IPv6 through the WHATWG `URL` parser.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/challenges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChallengeStore } from '../src/auth/challenges.js';

function store(max = 5) {
  const clock = { t: 1_000 };
  const s = new ChallengeStore({ ttlMs: 30_000, maxPendingPerIp: max, now: () => clock.t });
  return { s, clock };
}

describe('ChallengeStore', () => {
  it('issues a 32-byte base64url nonce, unique per connection', () => {
    const { s } = store();
    const a = s.issue('c1', 'ip')!;
    const b = s.issue('c2', 'ip')!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('is single use', () => {
    const { s } = store();
    const nonce = s.issue('c1', 'ip');
    expect(s.take('c1')).toEqual({ ok: true, nonce });
    expect(s.take('c1')).toEqual({ ok: false, reason: 'missing' });
  });

  it('expires strictly after the TTL of the injected clock', () => {
    const { s, clock } = store();
    s.issue('c1', 'ip');
    clock.t += 30_000;
    expect(s.take('c1').ok).toBe(true);
    s.issue('c2', 'ip');
    clock.t += 30_001;
    expect(s.take('c2')).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a second challenge on the same connection', () => {
    const { s } = store();
    s.issue('c1', 'ip');
    expect(() => s.issue('c1', 'ip')).toThrow();
  });

  it('limits pending challenges per IP and frees slots on take/drop', () => {
    const { s } = store(2);
    expect(s.issue('c1', 'a')).not.toBeNull();
    expect(s.issue('c2', 'a')).not.toBeNull();
    expect(s.issue('c3', 'a')).toBeNull();
    expect(s.issue('c4', 'b')).not.toBeNull(); // other IPs unaffected
    s.take('c1');
    expect(s.issue('c5', 'a')).not.toBeNull();
    s.drop('c2');
    s.drop('c2'); // idempotent
    expect(s.pendingFor('a')).toBe(1);
    s.drop('c5');
    s.drop('c4');
    expect(s.pendingFor('a')).toBe(0);
    expect(s.size).toBe(0);
  });
});
```

`apps/server/test/limiter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter, ipKey } from '../src/ratelimit/limiter.js';

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window and then refuses', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(3, 1_000, () => clock.t);
    expect([l.hit('k'), l.hit('k'), l.hit('k'), l.hit('k')]).toEqual([true, true, true, false]);
    expect(l.hit('other')).toBe(true);
  });

  it('slides: each hit expires exactly windowMs after it happened', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(2, 1_000, () => clock.t);
    l.hit('k');
    clock.t = 500;
    l.hit('k');
    clock.t = 999;
    expect(l.peek('k')).toBe(false);
    clock.t = 1_000;
    expect(l.peek('k')).toBe(true); // the t=0 hit left the window
    expect(l.hit('k')).toBe(true);
    expect(l.hit('k')).toBe(false); // t=500 still inside
  });

  it('peek never records and refused hits are not recorded', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(1, 1_000, () => clock.t);
    for (let i = 0; i < 5; i++) expect(l.peek('k')).toBe(true);
    expect(l.hit('k')).toBe(true);
    expect(l.hit('k')).toBe(false);
    clock.t = 1_000;
    expect(l.hit('k')).toBe(true);
  });

  it('sweep forgets idle keys', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(5, 1_000, () => clock.t);
    for (let i = 0; i < 100; i++) l.hit(`k${i}`);
    expect(l.size).toBe(100);
    clock.t = 5_000;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe('ipKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:0:0:ffff::2', '2001:db8:0:0::/64'],
    ['2001:0DB8:0000:0000:1:2:3:4', '2001:db8:0:0::/64'],
    ['2001:db8:0:1::1', '2001:db8:0:1::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['[2001:db8::9]', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s → %s', (input, key) => {
    expect(ipKey(input)).toBe(key);
  });

  it('groups a whole /64 together but separates neighbouring /64s', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe(ipKey('2001:db8:1:2:bbbb::ffff'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
  });

  it('passes unknown formats through unchanged', () => {
    expect(ipKey('unknown')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- apps/server/test/challenges.test.ts apps/server/test/limiter.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/challenges.js'` / `'../src/ratelimit/limiter.js'`.

- [ ] **Step 3: Implement `auth/challenges.ts`**

```ts
import { randomBytes } from 'node:crypto';

export type ChallengeTake =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'missing' | 'expired' };

interface Pending {
  nonce: string;
  ipKey: string;
  expiresAt: number;
}

/**
 * One nonce per connection: 32 random bytes, single use, expires after `ttlMs`
 * of the injected clock. Also enforces the pending-challenges-per-IP limit.
 */
export class ChallengeStore {
  readonly #byConnection = new Map<string, Pending>();
  readonly #pendingPerIp = new Map<string, number>();

  constructor(private readonly opts: { ttlMs: number; maxPendingPerIp: number; now: () => number }) {}

  /** Returns the new nonce, or null when this IP already has too many pending challenges. */
  issue(connectionId: string, ipKey: string): string | null {
    if (this.#byConnection.has(connectionId)) throw new Error(`connection ${connectionId} already has a challenge`);
    const pending = this.#pendingPerIp.get(ipKey) ?? 0;
    if (pending >= this.opts.maxPendingPerIp) return null;
    const nonce = randomBytes(32).toString('base64url');
    this.#byConnection.set(connectionId, { nonce, ipKey, expiresAt: this.opts.now() + this.opts.ttlMs });
    this.#pendingPerIp.set(ipKey, pending + 1);
    return nonce;
  }

  /** Removes and returns the connection's nonce; a nonce can be taken at most once. */
  take(connectionId: string): ChallengeTake {
    const entry = this.#byConnection.get(connectionId);
    if (!entry) return { ok: false, reason: 'missing' };
    this.drop(connectionId);
    if (this.opts.now() > entry.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: true, nonce: entry.nonce };
  }

  /** Forgets the connection's challenge (called when the socket closes). */
  drop(connectionId: string): void {
    const entry = this.#byConnection.get(connectionId);
    if (!entry) return;
    this.#byConnection.delete(connectionId);
    const left = (this.#pendingPerIp.get(entry.ipKey) ?? 1) - 1;
    if (left > 0) this.#pendingPerIp.set(entry.ipKey, left);
    else this.#pendingPerIp.delete(entry.ipKey);
  }

  pendingFor(ipKey: string): number {
    return this.#pendingPerIp.get(ipKey) ?? 0;
  }

  get size(): number {
    return this.#byConnection.size;
  }
}
```

- [ ] **Step 4: Implement `ratelimit/limiter.ts`**

```ts
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Sliding-window counter: at most `limit` hits per `windowMs` per key, measured
 * with the injected clock. `hit` records only when allowed; `peek` never records.
 */
export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  hit(key: string): boolean {
    const hits = this.#prune(key);
    if (hits.length >= this.limit) return false;
    hits.push(this.now());
    this.#hits.set(key, hits);
    return true;
  }

  peek(key: string): boolean {
    return this.#prune(key).length < this.limit;
  }

  /** Drops keys whose hits all left the window (call periodically to bound memory). */
  sweep(): void {
    for (const key of [...this.#hits.keys()]) this.#prune(key);
  }

  get size(): number {
    return this.#hits.size;
  }

  #prune(key: string): number[] {
    const hits = this.#hits.get(key) ?? [];
    const cutoff = this.now() - this.windowMs;
    let expired = 0;
    while (expired < hits.length && hits[expired]! <= cutoff) expired++;
    if (expired > 0) hits.splice(0, expired);
    if (hits.length === 0) this.#hits.delete(key);
    return hits;
  }
}

function ipv6Groups(address: string): number[] | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); // also turns a dotted IPv4 tail into hex
  } catch {
    return null;
  }
  const [head, tail] = canonical.includes('::') ? canonical.split('::') : [canonical, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/**
 * Rate-limit key for a remote address: IPv4 as-is, IPv4-mapped IPv6 as its IPv4,
 * and native IPv6 grouped by /64 (one subscriber usually owns a whole /64).
 */
export function ipKey(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIPv4(s)) return s;
  if (isIPv6(s)) {
    const g = ipv6Groups(s);
    if (g) {
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
        return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
      }
      return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
    }
  }
  return s;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- apps/server/test/challenges.test.ts apps/server/test/limiter.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  21 passed (21)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/challenges.ts apps/server/src/ratelimit/limiter.ts apps/server/test/challenges.test.ts apps/server/test/limiter.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add challenge store and sliding-window rate limiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Invites with atomic consumption

**Files:**
- Create: `apps/server/src/invites/invites.ts`
- Test: `apps/server/test/invites.test.ts`

Spec §3.5: codes are 10 random base32 characters (50 bits). `consumeInviteTx` is exactly the spec's conditional `UPDATE … WHERE code = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)` and succeeds only when `changes === 1`; it refuses to run outside `db.tx`, so a rollback later in the admission transaction gives the use back. `buildInviteInfo` builds the three formats from shared; `InviteInfo` lives here and is re-exported by `index.ts` (Task 19) to avoid an import cycle.

- [ ] **Step 1: Write the failing test**

`apps/server/test/invites.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProtocolError, parseJoinInput, toBase64Url } from '@ghostlink/shared';
import { Db } from '../src/db/database.js';
import { buildInviteInfo, consumeInviteTx, createInvite } from '../src/invites/invites.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-inv-'));
  db = new Db(join(dir, 'ghostlink.db'));
  db.migrate();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const consume = (code: string, now: number) => db.tx(() => consumeInviteTx(db, code, now));
const row = (code: string) => db.get<{ uses: number; max_uses: number | null; expires_at: number | null; created_by: string | null }>(
  'SELECT uses, max_uses, expires_at, created_by FROM invites WHERE code = ?', code);

describe('createInvite', () => {
  it('creates a 10-char base32 code with the given limits', () => {
    const { code } = createInvite(db, { maxUses: 3, expiresInHours: 24, createdBy: 'u1', now: 1_000 });
    expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(row(code)).toEqual({ uses: 0, max_uses: 3, expires_at: 1_000 + 24 * 3_600_000, created_by: 'u1' });
  });

  it('defaults to unlimited uses, no expiry and no creator', () => {
    const { code } = createInvite(db, { now: 0 });
    expect(row(code)).toEqual({ uses: 0, max_uses: null, expires_at: null, created_by: null });
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => createInvite(db, { now: 0 }).code));
    expect(codes.size).toBe(200);
  });

  it.each([
    [{ maxUses: 0 }], [{ maxUses: -1 }], [{ maxUses: 1.5 }], [{ maxUses: 10_001 }],
    [{ expiresInHours: 0 }], [{ expiresInHours: -2 }], [{ expiresInHours: Number.NaN }], [{ expiresInHours: 24 * 366 }],
  ])('rejects %j', (opts) => {
    expect(() => createInvite(db, { ...opts, now: 0 })).toThrow(ProtocolError);
  });
});

describe('consumeInviteTx', () => {
  it('must run inside a transaction', () => {
    const { code } = createInvite(db, { now: 0 });
    expect(() => consumeInviteTx(db, code, 0)).toThrow(/inside db.tx/);
  });

  it('honours max_uses exactly', () => {
    const { code } = createInvite(db, { maxUses: 2, now: 0 });
    expect([consume(code, 1), consume(code, 1), consume(code, 1)]).toEqual([true, true, false]);
    expect(row(code)?.uses).toBe(2);
  });

  it('refuses at and after expires_at', () => {
    const { code } = createInvite(db, { expiresInHours: 1, now: 0 });
    expect(consume(code, 3_599_999)).toBe(true);
    expect(consume(code, 3_600_000)).toBe(false);
  });

  it('refuses revoked and unknown codes', () => {
    const { code } = createInvite(db, { now: 0 });
    db.run('UPDATE invites SET revoked = 1 WHERE code = ?', code);
    expect(consume(code, 0)).toBe(false);
    expect(consume('AAAAAAAAAA', 0)).toBe(false);
  });

  it('gives the use back when the surrounding transaction rolls back', () => {
    const { code } = createInvite(db, { maxUses: 1, now: 0 });
    expect(() => db.tx(() => {
      consumeInviteTx(db, code, 0);
      throw new Error('later step failed');
    })).toThrow();
    expect(row(code)?.uses).toBe(0);
    expect(consume(code, 0)).toBe(true);
  });
});

describe('buildInviteInfo', () => {
  it('builds link, paste code and web link that all parse back to the same invite', () => {
    const serverKeyId = toBase64Url(new Uint8Array(32).fill(5));
    const info = buildInviteInfo('ABCDEFGH23', { addresses: ['203.0.113.1:7700'], serverKeyId, name: 'Casa' });
    const expected = { kind: 'invite', invite: { addresses: ['203.0.113.1:7700'], serverKeyId, inviteCode: 'ABCDEFGH23', name: 'Casa' } };
    expect(info.code).toBe('ABCDEFGH23');
    expect(parseJoinInput(info.link)).toEqual(expected);
    expect(parseJoinInput(info.pasteCode)).toEqual(expected);
    expect(parseJoinInput(info.webLink)).toEqual(expected);
    expect(info.webLink.startsWith('https://ghostlink.invalid/j/#GL1-')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/invites.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/invites/invites.js'`.

- [ ] **Step 3: Implement `invites/invites.ts`**

```ts
import { randomBytes } from 'node:crypto';
import {
  ProtocolError,
  formatInviteLink,
  formatPasteCode,
  formatWebLink,
  toBase32,
  type InvitePayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { WEB_SITE_BASE } from '../version.js';

export interface InviteInfo {
  code: string;
  link: string;
  pasteCode: string;
  webLink: string;
}

export interface CreateInviteOptions {
  maxUses?: number;
  expiresInHours?: number;
  createdBy?: string | null;
  now: number;
}

const MAX_USES_LIMIT = 10_000;
const MAX_EXPIRY_HOURS = 24 * 365;

/** 10 random base32 characters = 50 bits (spec §3.5). */
function randomCode(): string {
  return toBase32(randomBytes(7)).slice(0, 10);
}

export function createInvite(db: Db, opts: CreateInviteOptions): { code: string } {
  const { maxUses, expiresInHours } = opts;
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_LIMIT)) {
    throw new ProtocolError('BAD_REQUEST', `maxUses must be an integer between 1 and ${MAX_USES_LIMIT}`);
  }
  if (expiresInHours !== undefined && (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > MAX_EXPIRY_HOURS)) {
    throw new ProtocolError('BAD_REQUEST', `expiresInHours must be between 0 and ${MAX_EXPIRY_HOURS}`);
  }
  const expiresAt = expiresInHours === undefined ? null : opts.now + Math.round(expiresInHours * 3_600_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const r = db.run(
      'INSERT OR IGNORE INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
      code,
      opts.createdBy ?? null,
      opts.now,
      expiresAt,
      maxUses ?? null,
    );
    if (r.changes === 1) return { code };
  }
  throw new Error('could not generate a unique invite code');
}

/**
 * Consumes one use atomically (spec §3.5). Must run inside `db.tx` together with
 * the membership insert, so a later failure in that transaction gives the use back.
 */
export function consumeInviteTx(db: Db, code: string, now: number): boolean {
  if (!db.inTransaction) throw new Error('consumeInviteTx must be called inside db.tx');
  const r = db.run(
    `UPDATE invites SET uses = uses + 1
     WHERE code = ? AND revoked = 0
       AND (max_uses IS NULL OR uses < max_uses)
       AND (expires_at IS NULL OR expires_at > ?)`,
    code,
    now,
  );
  return r.changes === 1;
}

export function buildInviteInfo(code: string, meta: { addresses: string[]; serverKeyId: string; name: string }): InviteInfo {
  const payload: InvitePayload = { addresses: meta.addresses, serverKeyId: meta.serverKeyId, inviteCode: code, name: meta.name };
  return {
    code,
    link: formatInviteLink(payload),
    pasteCode: formatPasteCode(payload),
    webLink: formatWebLink(payload, WEB_SITE_BASE),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- apps/server/test/invites.test.ts`
Expected: PASS — `Tests  17 passed (17)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/invites/invites.ts apps/server/test/invites.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add invites with atomic consumption

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Session registry and request dispatcher

**Files:**
- Create: `apps/server/src/ws/sessions.ts`, `apps/server/src/ws/dispatch.ts`
- Test: `apps/server/test/sessions.test.ts`, `apps/server/test/dispatch.test.ts`

`SessionRegistry` keeps one session per `userId`; adding a second one terminates the first with `SESSION_REPLACED`, and a late `remove` of the replaced session must not evict its replacement. The dispatcher maps request types to handlers (M1: only `ping` → `{ t: serverTime }`, strict empty payload), answers unknown types — including prototype keys such as `__proto__` — with `BAD_REQUEST`, ignores envelopes without `id`, and turns unexpected exceptions into `INTERNAL` without leaking their message.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@ghostlink/shared';
import { SessionRegistry, type SessionHandle } from '../src/ws/sessions.js';

function handle(userId: string, sessionId: string): SessionHandle & { terminated: ErrorCode[] } {
  const terminated: ErrorCode[] = [];
  return { userId, sessionId, terminated, terminate: (code) => terminated.push(code) };
}

describe('SessionRegistry', () => {
  it('replaces an older session of the same user with SESSION_REPLACED', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u1', 's2');
    r.add(a);
    r.add(b);
    expect(a.terminated).toEqual(['SESSION_REPLACED']);
    expect(b.terminated).toEqual([]);
    expect(r.isCurrent(b)).toBe(true);
    expect(r.isCurrent(a)).toBe(false);
  });

  it('keeps different users independent', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u2', 's2');
    r.add(a);
    r.add(b);
    expect(a.terminated).toEqual([]);
    expect(r.size).toBe(2);
  });

  it('removing a replaced session does not remove its replacement', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u1', 's2');
    r.add(a);
    r.add(b);
    r.remove(a); // the old socket's close handler runs late
    expect(r.get('u1')).toBe(b);
    r.remove(b);
    expect(r.get('u1')).toBeUndefined();
  });

  it('re-adding the same handle does not terminate it', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    r.add(a);
    r.add(a);
    expect(a.terminated).toEqual([]);
  });
});
```

`apps/server/test/dispatch.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import type { Logger } from '../src/logger.js';
import { M1_HANDLERS, createDispatcher } from '../src/ws/dispatch.js';

const ctx = { userId: 'u', sessionId: 's', now: () => 1234 };
const logger = () => ({ info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() });

describe('dispatch', () => {
  it('answers ping with the server time', async () => {
    const dispatch = createDispatcher(M1_HANDLERS, logger());
    expect(await dispatch(ctx, { t: 'ping', id: 7, d: {} })).toEqual({ t: 'res', id: 7, ok: true, d: { t: 1234 } });
    expect(await dispatch(ctx, { t: 'ping', id: 8 })).toEqual({ t: 'res', id: 8, ok: true, d: { t: 1234 } });
  });

  it('rejects a ping payload with unknown keys (strict schemas)', async () => {
    const dispatch = createDispatcher(M1_HANDLERS, logger());
    expect(await dispatch(ctx, { t: 'ping', id: 1, d: { x: 1 } })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('answers unknown types with BAD_REQUEST, including prototype keys', async () => {
    const dispatch = createDispatcher(M1_HANDLERS, logger());
    for (const t of ['msg.send', 'toString', '__proto__', 'constructor', 'hello']) {
      expect(await dispatch(ctx, { t, id: 1 }), t).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'BAD_REQUEST' } });
    }
  });

  it('ignores envelopes without an id', async () => {
    const dispatch = createDispatcher(M1_HANDLERS, logger());
    expect(await dispatch(ctx, { t: 'ping' })).toBeNull();
  });

  it('maps ProtocolError to its code and hides unexpected errors as INTERNAL', async () => {
    const log = logger();
    const dispatch = createDispatcher({
      forbidden: () => {
        throw new ProtocolError('FORBIDDEN', 'nope');
      },
      crash: () => {
        throw new Error('secret internals');
      },
    }, log);
    expect(await dispatch(ctx, { t: 'forbidden', id: 1 })).toEqual({ t: 'res', id: 1, ok: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    const crashed = await dispatch(ctx, { t: 'crash', id: 2 });
    expect(crashed).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'INTERNAL', message: 'INTERNAL' } });
    expect(log.error).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- apps/server/test/sessions.test.ts apps/server/test/dispatch.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/ws/sessions.js'` / `'../src/ws/dispatch.js'`.

- [ ] **Step 3: Implement `ws/sessions.ts`**

```ts
import type { ErrorCode } from '@ghostlink/shared';

export interface SessionHandle {
  readonly userId: string;
  readonly sessionId: string;
  terminate(code: ErrorCode): void;
}

/** One live session per identity: a new login replaces the old one with SESSION_REPLACED (spec §3.3). */
export class SessionRegistry {
  readonly #byUser = new Map<string, SessionHandle>();

  add(session: SessionHandle): void {
    const previous = this.#byUser.get(session.userId);
    this.#byUser.set(session.userId, session);
    if (previous && previous !== session) previous.terminate('SESSION_REPLACED');
  }

  /** Removes the session only if it is still the current one for its user. */
  remove(session: SessionHandle): void {
    if (this.#byUser.get(session.userId) === session) this.#byUser.delete(session.userId);
  }

  isCurrent(session: SessionHandle): boolean {
    return this.#byUser.get(session.userId) === session;
  }

  get(userId: string): SessionHandle | undefined {
    return this.#byUser.get(userId);
  }

  get size(): number {
    return this.#byUser.size;
  }
}
```

- [ ] **Step 4: Implement `ws/dispatch.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- apps/server/test/sessions.test.ts apps/server/test/dispatch.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  9 passed (9)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ws/sessions.ts apps/server/src/ws/dispatch.ts apps/server/test/sessions.test.ts apps/server/test/dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add session registry and request dispatcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: WebSocket connection (serial inbox, deadlines, heartbeat)

**Files:**
- Create: `apps/server/src/ws/connection.ts`
- Test: `apps/server/test/connection.test.ts`

Spec §5.1: messages of one socket are processed serially; `maxPayload` is 256 KiB (enforced by the `WebSocketServer` in Task 19); ping every 15 s, drop after 30 s without pong. `Connection` parses and validates every text frame with `envelopeSchema` and hands envelopes out one at a time through `nextEnvelope()` — the consumer's `await` loop *is* the serial queue. Invalid frames surface as a rejected `nextEnvelope()` with `ProtocolError('BAD_REQUEST')` so the consumer decides (the handshake counts it as an auth failure). More than `MAX_INBOX` (64) unread frames means flooding → `RATE_LIMITED`. `close(code)` sends `{ t: 'error', d: { code, …extra } }` and then closes with application code **4000** and the code as the reason, with a 2 s terminate fallback. The heartbeat uses `performance.now()` on purpose: the injectable test clock may jump by minutes. The unit test drives a real `ws` pair over plain loopback HTTP (no TLS needed here).

- [ ] **Step 1: Write the failing test**

`apps/server/test/connection.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { Connection, ConnectionClosedError, MAX_INBOX, type ConnectionOptions } from '../src/ws/connection.js';

interface Pair {
  conn: Connection;
  client: WebSocket;
  received: unknown[];
  closed: Promise<{ code: number; reason: string }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A server-side Connection wired to a plain ws client over loopback HTTP. */
async function pair(opts: Partial<ConnectionOptions> = {}, clientOpts: WebSocket.ClientOptions = {}): Promise<Pair> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const connected = new Promise<Connection>((resolve) => {
    wss.once('connection', (ws) => {
      resolve(new Connection(ws, { ip: '127.0.0.1', ipKey: '127.0.0.1', pingIntervalMs: 60_000, pongTimeoutMs: 120_000, ...opts }));
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`, clientOpts);
  const received: unknown[] = [];
  client.on('message', (d) => received.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((r) => client.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise((r) => client.once('open', r));
  const conn = await connected;
  cleanups.push(async () => {
    client.terminate();
    wss.close();
    await new Promise((r) => http.close(r));
  });
  return { conn, client, received, closed };
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('Connection', () => {
  it('hands out envelopes one at a time, in arrival order', async () => {
    const { conn, client } = await pair();
    for (const t of ['a', 'b', 'c']) client.send(JSON.stringify({ t, id: 1 }));
    expect((await conn.nextEnvelope()).t).toBe('a');
    expect((await conn.nextEnvelope()).t).toBe('b');
    expect((await conn.nextEnvelope()).t).toBe('c');
    const pending = conn.nextEnvelope();
    client.send(JSON.stringify({ t: 'd', d: { x: 1 } }));
    expect(await pending).toEqual({ t: 'd', d: { x: 1 } });
  });

  it('refuses a second concurrent nextEnvelope()', async () => {
    const { conn } = await pair();
    void conn.nextEnvelope().catch(() => {});
    await expect(conn.nextEnvelope()).rejects.toThrow(/already pending/);
  });

  it.each([
    ['invalid JSON', '{nope', false],
    ['an envelope without t', JSON.stringify({ id: 1 }), false],
    ['a negative id', JSON.stringify({ t: 'x', id: -1 }), false],
    ['a binary frame', JSON.stringify({ t: 'x' }), true],
  ])('reports %s as ProtocolError(BAD_REQUEST) without closing', async (_label, frame, binary) => {
    const { conn, client } = await pair();
    client.send(binary ? Buffer.from(frame) : frame, { binary });
    await expect(conn.nextEnvelope()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(conn.closed).toBe(false);
    client.send(JSON.stringify({ t: 'ok' }));
    expect((await conn.nextEnvelope()).t).toBe('ok');
  });

  it('close() sends the error event, closes with 4000 + code and is idempotent', async () => {
    const { conn, received, closed } = await pair();
    const pending = conn.nextEnvelope();
    conn.close('PROTOCOL_UNSUPPORTED', { min: 1, max: 1 });
    conn.close('INTERNAL');
    conn.send({ t: 'late' });
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(await closed).toEqual({ code: 4000, reason: 'PROTOCOL_UNSUPPORTED' });
    expect(received).toEqual([{ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } }]);
    await expect(conn.nextEnvelope()).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('runs a deadline once, and clearDeadline/replacing cancels it', async () => {
    const { conn } = await pair();
    let fired = 0;
    conn.setDeadline(30, () => fired++);
    conn.clearDeadline();
    conn.setDeadline(30, () => (fired += 10));
    conn.setDeadline(60, () => (fired += 100));
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(100);
  });

  it(`closes with RATE_LIMITED when more than ${MAX_INBOX} frames pile up unread`, async () => {
    const { client, received, closed } = await pair();
    for (let i = 0; i <= MAX_INBOX; i++) client.send(JSON.stringify({ t: 'x', id: i }));
    expect((await closed).reason).toBe('RATE_LIMITED');
    expect(received).toEqual([{ t: 'error', d: { code: 'RATE_LIMITED' } }]);
  });

  it('terminates a peer that does not answer pings', async () => {
    const { closed } = await pair({ pingIntervalMs: 20, pongTimeoutMs: 100 }, { autoPong: false });
    expect((await closed).code).toBe(1006);
  });

  it('keeps a peer that answers pings', async () => {
    const { conn } = await pair({ pingIntervalMs: 100, pongTimeoutMs: 1_000 });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(conn.closed).toBe(false);
  });

  it('runs onClose listeners once, including ones added after the close', async () => {
    const { conn, client } = await pair();
    let calls = 0;
    conn.onClose(() => calls++);
    client.close();
    await waitFor(() => conn.socketClosed);
    let late = 0;
    conn.onClose(() => late++);
    await waitFor(() => late === 1);
    expect(calls).toBe(1);
    expect(conn.state).toBe('closed');
  });

});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/connection.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/ws/connection.js'`.

- [ ] **Step 3: Implement `ws/connection.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RawData, WebSocket } from 'ws';
import { ProtocolError, envelopeSchema, type Envelope, type ErrorCode } from '@ghostlink/shared';

/** Application close code; the reason string is the ErrorCode. */
export const APP_CLOSE_CODE = 4000;
/** Frames queued while the previous one is still being handled; beyond this the peer is flooding. */
export const MAX_INBOX = 64;
const CLOSE_GRACE_MS = 2_000;

export type ConnectionState = 'awaiting-hello' | 'awaiting-proof' | 'authenticated' | 'closed';

export class ConnectionClosedError extends Error {
  constructor() {
    super('connection closed');
    this.name = 'ConnectionClosedError';
  }
}

export interface ConnectionOptions {
  ip: string;
  ipKey: string;
  pingIntervalMs: number;
  pongTimeoutMs: number;
}

type InboxItem = Envelope | ProtocolError;

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * One WebSocket. Frames are parsed and validated as envelopes, then handed out
 * one at a time through `nextEnvelope()`, which gives each socket a serial
 * processing order (spec §5.1). Also owns the handshake deadline and the
 * ping/pong heartbeat (spec §5.1: ping every 15 s, drop after 30 s without pong).
 */
export class Connection {
  readonly id = randomUUID();
  readonly ip: string;
  readonly ipKey: string;
  state: ConnectionState = 'awaiting-hello';

  readonly #ws: WebSocket;
  readonly #inbox: InboxItem[] = [];
  #waiter: { resolve: (e: Envelope) => void; reject: (e: Error) => void } | null = null;
  #deadline: NodeJS.Timeout | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  readonly #heartbeat: NodeJS.Timeout;
  #lastPong = performance.now();
  #socketClosed = false;
  readonly #closeListeners: Array<() => void> = [];

  constructor(ws: WebSocket, opts: ConnectionOptions) {
    this.#ws = ws;
    this.ip = opts.ip;
    this.ipKey = opts.ipKey;
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('pong', () => {
      this.#lastPong = performance.now();
    });
    ws.on('error', () => {
      // 'close' always follows; nothing to do here.
    });
    ws.on('close', () => this.#onSocketClosed());
    // Real monotonic time on purpose: the injected test clock may jump by minutes.
    this.#heartbeat = setInterval(() => {
      if (performance.now() - this.#lastPong > opts.pongTimeoutMs) {
        this.terminate();
        return;
      }
      if (this.#ws.readyState === this.#ws.OPEN) this.#ws.ping();
    }, opts.pingIntervalMs);
    this.#heartbeat.unref();
  }

  /** Resolves with the next valid envelope; rejects with ProtocolError for an invalid frame or ConnectionClosedError. */
  nextEnvelope(): Promise<Envelope> {
    if (this.state === 'closed') return Promise.reject(new ConnectionClosedError());
    if (this.#waiter) return Promise.reject(new Error('nextEnvelope() is already pending'));
    const item = this.#inbox.shift();
    if (item instanceof ProtocolError) return Promise.reject(item);
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<Envelope>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  send(envelope: object): void {
    if (this.state !== 'closed') this.#write(envelope);
  }

  /** Sends `error { code, ...extra }`, then closes with APP_CLOSE_CODE and the code as reason. Idempotent. */
  close(code: ErrorCode, extra?: { min?: number; max?: number }): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearDeadline();
    this.#write({ t: 'error', d: { code, ...extra } });
    this.#ws.close(APP_CLOSE_CODE, code);
    this.#killTimer = setTimeout(() => this.#ws.terminate(), CLOSE_GRACE_MS);
    this.#killTimer.unref();
    this.#rejectWaiter();
  }

  /** Drops the socket without a goodbye (unresponsive peer). */
  terminate(): void {
    this.state = 'closed';
    this.clearDeadline();
    this.#ws.terminate();
    this.#rejectWaiter();
  }

  /** Runs `onExpire` unless cleared or replaced within `ms`. */
  setDeadline(ms: number, onExpire: () => void): void {
    this.clearDeadline();
    this.#deadline = setTimeout(() => {
      this.#deadline = null;
      if (this.state !== 'closed') onExpire();
    }, ms);
    this.#deadline.unref();
  }

  clearDeadline(): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = null;
  }

  /** Called once when the socket is fully closed (immediately if it already is). */
  onClose(listener: () => void): void {
    if (this.#socketClosed) queueMicrotask(listener);
    else this.#closeListeners.push(listener);
  }

  /** True once close()/terminate() ran or the socket closed (a getter, so TS does not narrow it away). */
  get closed(): boolean {
    return this.state === 'closed';
  }

  get socketClosed(): boolean {
    return this.#socketClosed;
  }

  #write(envelope: object): void {
    if (this.#ws.readyState === this.#ws.OPEN) this.#ws.send(JSON.stringify(envelope));
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    let item: InboxItem;
    if (isBinary) {
      item = new ProtocolError('BAD_REQUEST', 'binary frames are not supported');
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(data));
      } catch {
        parsed = undefined;
      }
      const envelope = envelopeSchema.safeParse(parsed);
      item = envelope.success ? envelope.data : new ProtocolError('BAD_REQUEST', 'invalid envelope');
    }
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      if (item instanceof ProtocolError) waiter.reject(item);
      else waiter.resolve(item);
      return;
    }
    if (this.#inbox.length >= MAX_INBOX) {
      this.close('RATE_LIMITED');
      return;
    }
    this.#inbox.push(item);
  }

  #rejectWaiter(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(new ConnectionClosedError());
  }

  #onSocketClosed(): void {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    this.state = 'closed';
    this.clearDeadline();
    clearInterval(this.#heartbeat);
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#inbox.length = 0;
    this.#rejectWaiter();
    for (const listener of this.#closeListeners.splice(0)) listener();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- apps/server/test/connection.test.ts`
Expected: PASS — `Tests  12 passed (12)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ws/connection.ts apps/server/test/connection.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add WebSocket connection with serial inbox and heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Admission — join modes in one synchronous transaction

**Files:**
- Create: `apps/server/src/auth/admission.ts`
- Test: `apps/server/test/admission.test.ts`

`admit()` decides whether a *verified* identity may enter (spec §3.3, §3.5, §7, §13). Order:
1. Ban by user id, public key or IP key → `BANNED`.
2. `setupCode` present → must match (`BAD_SETUP_CODE`); it then bypasses invite, password, `max_members` and the new-identity limit (not bans or the rejoin block).
3. Existing member (`removed_at IS NULL`) → enters with no password/invite; only `last_seen_at`, `last_ip`, `locale` are refreshed (nickname changes arrive with `profile.update` in M2).
4. Removed member with `rejoin_blocked_until > now` → `REJOIN_BLOCKED`.
5. New or returning identity: `password` mode verifies scrypt (the only `await`, done **before** the transaction; missing/unset password → `BAD_PASSWORD`); `invite` mode requires a well-formed code (`INVITE_REQUIRED` / `INVITE_INVALID`).
6. **One synchronous `db.tx`**: consume the invite (`INVITE_INVALID`), check `max_members` (`SERVER_FULL`), the 5-new-identities-per-IP-per-hour limit (`RATE_LIMITED`, new identities only), nickname uniqueness (`NICK_TAKEN`), insert or reactivate the user, consume the setup code last. Any rejection throws inside the transaction, so the invite use is rolled back.

`countsAsFailure` is true only for credential failures (`BANNED`, `BAD_SETUP_CODE`, `BAD_PASSWORD`, `INVITE_REQUIRED`, `INVITE_INVALID`); `NICK_TAKEN`, `SERVER_FULL`, `REJOIN_BLOCKED`, `RATE_LIMITED` do not burn the IP's auth-failure budget.

- [ ] **Step 1: Write the failing test**

`apps/server/test/admission.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeNickname, type JoinMode } from '@ghostlink/shared';
import { admit, type AdmissionDeps, type AdmissionRequest } from '../src/auth/admission.js';
import { hashPassword } from '../src/auth/password.js';
import { ensureSetupCode } from '../src/auth/setupCode.js';
import { dataPaths, ensureDataDirs } from '../src/config/paths.js';
import { Db } from '../src/db/database.js';
import { ensureMeta, getMeta } from '../src/db/serverMeta.js';
import { createInvite } from '../src/invites/invites.js';
import { SlidingWindowLimiter } from '../src/ratelimit/limiter.js';
import { makeIdentity, type TestIdentity } from './helpers/identity.js';

interface Env {
  dir: string;
  db: Db;
  clock: { t: number };
  deps: AdmissionDeps;
}
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) {
    e.db.close();
    rmSync(e.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function env(joinMode: JoinMode): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-admit-'));
  const db = new Db(ensureDataDirs(dir).db);
  db.migrate();
  ensureMeta(db, { name: 'S', joinMode, now: 0 });
  const clock = { t: 10_000_000 };
  const deps: AdmissionDeps = { db, dataDir: dir, now: () => clock.t, newIdentities: new SlidingWindowLimiter(5, 3_600_000, () => clock.t) };
  const e = { dir, db, clock, deps };
  envs.push(e);
  return e;
}

function req(id: TestIdentity, extra: Partial<AdmissionRequest> & { nick?: string } = {}): AdmissionRequest {
  const { nick = `n${id.userId.slice(0, 8)}`, ...rest } = extra;
  return {
    userId: id.userId,
    publicKey: id.publicKeyRaw,
    nickname: normalizeNickname(nick),
    locale: 'pt-BR',
    ip: '203.0.113.1',
    ipKey: '203.0.113.1',
    ...rest,
  };
}

const uses = (db: Db, code: string) => Number(db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', code)?.uses);
const users = (db: Db) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n);

describe('admit — open mode', () => {
  it('inserts a new member with the normalized nickname', async () => {
    const e = env('open');
    const id = makeIdentity();
    const r = await admit(req(id, { nick: ' Ana ' }), e.deps);
    expect(r).toEqual({ ok: true, user: { id: id.userId, nickname: 'Ana', isOwner: false }, created: true });
    expect(e.db.get('SELECT nickname, nickname_norm, last_ip, joined_at FROM users WHERE id = ?', id.userId))
      .toEqual({ nickname: 'Ana', nickname_norm: 'ana', last_ip: '203.0.113.1', joined_at: e.clock.t });
  });

  it('lets an existing member in and only refreshes last_seen/last_ip/locale', async () => {
    const e = env('open');
    const id = makeIdentity();
    await admit(req(id, { nick: 'Ana' }), e.deps);
    e.clock.t += 1_000;
    const r = await admit(req(id, { nick: 'Other', ip: '198.51.100.2', locale: 'en' }), e.deps);
    expect(r).toMatchObject({ ok: true, user: { nickname: 'Ana' }, created: false });
    expect(e.db.get('SELECT nickname, last_ip, locale, last_seen_at FROM users WHERE id = ?', id.userId))
      .toEqual({ nickname: 'Ana', last_ip: '198.51.100.2', locale: 'en', last_seen_at: e.clock.t });
  });

  it('refuses a taken nickname (case/NFKC-insensitive) → NICK_TAKEN, not a credential failure', async () => {
    const e = env('open');
    await admit(req(makeIdentity(), { nick: 'Ana' }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'ＡＮＡ' }), e.deps)).toEqual({ ok: false, code: 'NICK_TAKEN', countsAsFailure: false });
  });

  it('allows 5 new identities per IP per hour → then RATE_LIMITED; other IPs and members are unaffected', async () => {
    const e = env('open');
    const first = makeIdentity();
    await admit(req(first), e.deps);
    for (let i = 0; i < 4; i++) expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
    expect(await admit(req(makeIdentity()), e.deps)).toEqual({ ok: false, code: 'RATE_LIMITED', countsAsFailure: false });
    expect((await admit(req(makeIdentity(), { ipKey: '198.51.100.9' }), e.deps)).ok).toBe(true);
    expect((await admit(req(first), e.deps)).ok).toBe(true);
    e.clock.t += 3_600_001;
    expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
  });
});

describe('admit — invite mode', () => {
  it('requires an invite → INVITE_REQUIRED (credential failure)', async () => {
    const e = env('invite');
    expect(await admit(req(makeIdentity()), e.deps)).toEqual({ ok: false, code: 'INVITE_REQUIRED', countsAsFailure: true });
    expect(users(e.db)).toBe(0);
  });

  it('refuses malformed and unknown codes → INVITE_INVALID', async () => {
    const e = env('invite');
    expect(await admit(req(makeIdentity(), { inviteCode: '!!' }), e.deps)).toMatchObject({ ok: false, code: 'INVITE_INVALID', countsAsFailure: true });
    expect(await admit(req(makeIdentity(), { inviteCode: 'AAAAAAAAAA' }), e.deps)).toMatchObject({ ok: false, code: 'INVITE_INVALID' });
  });

  it('consumes one use per new identity and none for members', async () => {
    const e = env('invite');
    const { code } = createInvite(e.db, { now: 0 });
    const id = makeIdentity();
    expect((await admit(req(id, { inviteCode: code.toLowerCase() }), e.deps)).ok).toBe(true);
    expect((await admit(req(id, { inviteCode: code }), e.deps)).ok).toBe(true);
    expect((await admit(req(id), e.deps)).ok).toBe(true);
    expect(uses(e.db, code)).toBe(1);
  });

  it('gives the use back when a later check fails in the same transaction (NICK_TAKEN, SERVER_FULL)', async () => {
    const e = env('invite');
    const { code } = createInvite(e.db, { maxUses: 1, now: 0 });
    const seed = createInvite(e.db, { now: 0 }).code;
    await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: seed }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'ana', inviteCode: code }), e.deps)).toMatchObject({ code: 'NICK_TAKEN' });
    expect(uses(e.db, code)).toBe(0);
    e.db.run('UPDATE server_meta SET max_members = 1');
    expect(await admit(req(makeIdentity(), { inviteCode: code }), e.deps)).toEqual({ ok: false, code: 'SERVER_FULL', countsAsFailure: false });
    expect(uses(e.db, code)).toBe(0);
  });

  it('reports INVITE_INVALID before NICK_TAKEN (fix the invite first)', async () => {
    const e = env('invite');
    await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: 'AAAAAAAAAA' }), e.deps)).toMatchObject({ code: 'INVITE_INVALID' });
  });
});

describe('admit — password mode', () => {
  it('checks the password only for new identities', async () => {
    const e = env('password');
    e.db.run('UPDATE server_meta SET password_hash = ?', await hashPassword('pw'));
    const id = makeIdentity();
    expect(await admit(req(id), e.deps)).toEqual({ ok: false, code: 'BAD_PASSWORD', countsAsFailure: true });
    expect(await admit(req(id, { password: 'PW' }), e.deps)).toMatchObject({ ok: false, code: 'BAD_PASSWORD' });
    expect((await admit(req(id, { password: 'pw' }), e.deps)).ok).toBe(true);
    expect((await admit(req(id), e.deps)).ok).toBe(true);
  });

  it('refuses everyone new while no password is set', async () => {
    const e = env('password');
    expect(await admit(req(makeIdentity(), { password: 'x' }), e.deps)).toMatchObject({ ok: false, code: 'BAD_PASSWORD' });
  });
});

describe('admit — setup code', () => {
  it('makes the owner, bypassing invite and max_members, and burns the code', async () => {
    const e = env('invite');
    e.db.run('UPDATE server_meta SET max_members = 1');
    await admit(req(makeIdentity(), { inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    const code = ensureSetupCode(e.db, e.dir)!;
    const owner = makeIdentity();
    expect(await admit(req(owner, { setupCode: code }), e.deps)).toMatchObject({ ok: true, user: { isOwner: true } });
    expect(getMeta(e.db)).toMatchObject({ ownerUserId: owner.userId, setupCodeHash: null });
    expect(existsSync(dataPaths(e.dir).setupCodeFile)).toBe(false);
    expect(await admit(req(makeIdentity(), { setupCode: code }), e.deps)).toEqual({ ok: false, code: 'BAD_SETUP_CODE', countsAsFailure: true });
    expect((await admit(req(owner), e.deps))).toMatchObject({ ok: true, user: { isOwner: true } });
  });

  it('does not use up a new-identity slot', async () => {
    const e = env('open');
    const code = ensureSetupCode(e.db, e.dir)!;
    await admit(req(makeIdentity(), { setupCode: code }), e.deps);
    for (let i = 0; i < 5; i++) expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
  });

  it('keeps NICK_TAKEN and leaves the code usable', async () => {
    const e = env('open');
    await admit(req(makeIdentity(), { nick: 'Ana' }), e.deps);
    const code = ensureSetupCode(e.db, e.dir)!;
    expect(await admit(req(makeIdentity(), { nick: 'ana', setupCode: code }), e.deps)).toMatchObject({ code: 'NICK_TAKEN' });
    expect(getMeta(e.db).ownerUserId).toBeNull();
    expect(existsSync(dataPaths(e.dir).setupCodeFile)).toBe(true);
  });
});

describe('admit — bans and removal', () => {
  type BanRow = { userId: string; publicKey: Uint8Array | null; ip: string | null };
  it.each<[string, (id: TestIdentity) => BanRow]>([
    ['user id', (id) => ({ userId: id.userId, publicKey: null, ip: null })],
    ['public key', (id) => ({ userId: 'other', publicKey: id.publicKeyRaw, ip: null })],
    ['IP (/64 key)', () => ({ userId: 'other', publicKey: null, ip: '203.0.113.1' })],
  ])('refuses a ban by %s → BANNED', async (_label, row) => {
    const e = env('open');
    const id = makeIdentity();
    const ban = row(id);
    e.db.run('INSERT INTO bans (user_id, public_key, ip, created_at) VALUES (?, ?, ?, 0)', ban.userId, ban.publicKey, ban.ip);
    expect(await admit(req(id), e.deps)).toEqual({ ok: false, code: 'BANNED', countsAsFailure: true });
  });

  it('blocks rejoining until rejoin_blocked_until, then reactivates the same user through the join mode', async () => {
    const e = env('invite');
    const id = makeIdentity();
    await admit(req(id, { nick: 'Ana', inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    e.db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = ? WHERE id = ?', e.clock.t, e.clock.t + 600_000, id.userId);
    const { code } = createInvite(e.db, { maxUses: 1, now: 0 });
    expect(await admit(req(id, { inviteCode: code }), e.deps)).toEqual({ ok: false, code: 'REJOIN_BLOCKED', countsAsFailure: false });
    e.clock.t += 600_001;
    expect(await admit(req(id), e.deps)).toMatchObject({ code: 'INVITE_REQUIRED' });
    expect(await admit(req(id, { nick: 'Ana 2', inviteCode: code }), e.deps)).toEqual({
      ok: true, user: { id: id.userId, nickname: 'Ana 2', isOwner: false }, created: false,
    });
    expect(e.db.get('SELECT removed_at, rejoin_blocked_until FROM users WHERE id = ?', id.userId)).toEqual({ removed_at: null, rejoin_blocked_until: null });
    expect(uses(e.db, code)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/admission.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/auth/admission.js'`.

- [ ] **Step 3: Implement `auth/admission.ts`**

```ts
import { normalizeInviteCode, type ErrorCode } from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';
import { consumeInviteTx } from '../invites/invites.js';
import type { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { verifyPassword } from './password.js';
import { checkSetupCode, consumeSetupCode } from './setupCode.js';

export interface AdmissionRequest {
  userId: string;
  publicKey: Uint8Array;
  nickname: { display: string; norm: string };
  locale: string;
  ip: string;
  ipKey: string;
  password?: string;
  inviteCode?: string;
  setupCode?: string;
}

export interface AdmissionDeps {
  db: Db;
  dataDir: string;
  now: () => number;
  newIdentities: SlidingWindowLimiter;
}

export type AdmissionResult =
  | { ok: true; user: { id: string; nickname: string; isOwner: boolean }; created: boolean }
  | { ok: false; code: ErrorCode; countsAsFailure: boolean };

/** Codes caused by a bad credential; they count toward the per-IP auth-failure limit (spec §13). */
const CREDENTIAL_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BANNED', 'BAD_SETUP_CODE', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID',
]);

class Rejected extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function reject(code: ErrorCode): AdmissionResult {
  return { ok: false, code, countsAsFailure: CREDENTIAL_FAILURES.has(code) };
}

interface UserRow {
  id: string;
  nickname: string;
  removed_at: number | null;
  rejoin_blocked_until: number | null;
}

/**
 * Decides whether a verified identity may enter (spec §3.3/§3.5/§7). Everything
 * slow (scrypt) happens first; then ONE synchronous transaction re-reads the
 * state, consumes the invite, checks max_members, the new-identities-per-IP
 * limit and nickname uniqueness, and inserts or reactivates the user. Any
 * rejection inside the transaction rolls it back, giving the invite use back.
 */
export async function admit(req: AdmissionRequest, deps: AdmissionDeps): Promise<AdmissionResult> {
  const { db } = deps;
  const banned = db.get(
    'SELECT 1 AS x FROM bans WHERE user_id = ? OR public_key = ? OR (ip IS NOT NULL AND ip = ?) LIMIT 1',
    req.userId,
    req.publicKey,
    req.ipKey,
  );
  if (banned) return reject('BANNED');

  const wantsOwner = req.setupCode !== undefined;
  if (wantsOwner && !checkSetupCode(db, req.setupCode!)) return reject('BAD_SETUP_CODE');

  const existing = db.get<UserRow>('SELECT id, nickname, removed_at, rejoin_blocked_until FROM users WHERE public_key = ?', req.publicKey);
  const isMember = existing !== undefined && existing.removed_at === null;

  if (existing && !isMember && existing.rejoin_blocked_until !== null && existing.rejoin_blocked_until > deps.now()) {
    return reject('REJOIN_BLOCKED');
  }

  const meta = getMeta(db);
  let inviteCode: string | null = null;
  if (!isMember && !wantsOwner) {
    if (meta.joinMode === 'password') {
      if (req.password === undefined || meta.passwordHash === null) return reject('BAD_PASSWORD');
      if (!(await verifyPassword(req.password, meta.passwordHash))) return reject('BAD_PASSWORD');
    } else if (meta.joinMode === 'invite') {
      if (req.inviteCode === undefined) return reject('INVITE_REQUIRED');
      inviteCode = normalizeInviteCode(req.inviteCode);
      if (inviteCode === null) return reject('INVITE_INVALID');
    }
  }

  const now = deps.now();
  try {
    return db.tx((): AdmissionResult => {
      const current = getMeta(db);
      if (isMember) {
        db.run('UPDATE users SET last_seen_at = ?, last_ip = ?, locale = ? WHERE id = ?', now, req.ip, req.locale, existing.id);
        if (wantsOwner && !consumeSetupCode(db, deps.dataDir, req.setupCode!, existing.id)) throw new Rejected('BAD_SETUP_CODE');
        const isOwner = wantsOwner || current.ownerUserId === existing.id;
        return { ok: true, user: { id: existing.id, nickname: existing.nickname, isOwner }, created: false };
      }

      if (inviteCode !== null && !consumeInviteTx(db, inviteCode, now)) throw new Rejected('INVITE_INVALID');
      if (!wantsOwner) {
        const active = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL');
        if (Number(active?.n ?? 0) >= current.maxMembers) throw new Rejected('SERVER_FULL');
        if (!existing && !deps.newIdentities.peek(req.ipKey)) throw new Rejected('RATE_LIMITED');
      }
      const taken = db.get('SELECT 1 AS x FROM users WHERE nickname_norm = ? AND id <> ?', req.nickname.norm, req.userId);
      if (taken) throw new Rejected('NICK_TAKEN');

      if (existing) {
        db.run(
          `UPDATE users SET nickname = ?, nickname_norm = ?, locale = ?, last_seen_at = ?, last_ip = ?,
             removed_at = NULL, rejoin_blocked_until = NULL WHERE id = ?`,
          req.nickname.display, req.nickname.norm, req.locale, now, req.ip, existing.id,
        );
      } else {
        db.run(
          `INSERT INTO users (id, public_key, nickname, nickname_norm, locale, joined_at, last_seen_at, last_ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          req.userId, req.publicKey, req.nickname.display, req.nickname.norm, req.locale, now, now, req.ip,
        );
      }
      // Last step: nothing after it can fail, so the setup-code file is only deleted on success.
      if (wantsOwner && !consumeSetupCode(db, deps.dataDir, req.setupCode!, req.userId)) throw new Rejected('BAD_SETUP_CODE');
      if (!existing && !wantsOwner) deps.newIdentities.hit(req.ipKey);
      const isOwner = wantsOwner || current.ownerUserId === req.userId;
      return { ok: true, user: { id: req.userId, nickname: req.nickname.display, isOwner }, created: !existing };
    });
  } catch (e) {
    if (e instanceof Rejected) return reject(e.code);
    throw e;
  }
}
```

- [ ] **Step 4: Run the test, typecheck and lint**

Run:
```bash
npm test -- apps/server/test/admission.test.ts
npm run typecheck -w @ghostlink/server
npx eslint apps
```
Expected: PASS — `Tests  18 passed (18)`; no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth/admission.ts apps/server/test/admission.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add admission transaction for join modes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---


### Task 19: Handshake, WebSocket gateway, HTTPS routes and `startServer`

**Files:**
- Create: `apps/server/src/auth/handshake.ts`, `apps/server/src/ws/gateway.ts`, `apps/server/src/http/server.ts`, `apps/server/src/index.ts`
- Create (test helpers, reusable by plan 1b): `apps/server/test/helpers/testClient.ts`, `apps/server/test/helpers/db.ts`
- Test: `apps/server/test/integration/http.test.ts`, `apps/server/test/integration/handshake.test.ts`

This task wires everything into a running server.

**Handshake (spec §3.3)** — `runHandshake(conn, deps)`:
- `hello` must arrive within `helloTimeoutMs` (5 s) → otherwise `BAD_REQUEST` (no dedicated code exists; see Contract notes). An IP over its auth-failure budget gets `RATE_LIMITED` before anything else is done. Then: strict schema (`BAD_REQUEST`), protocol range (`PROTOCOL_UNSUPPORTED` with `min`/`max`, not a credential failure), public key decodes to 32 bytes and is not small-order, nickname normalizes (`BAD_REQUEST`), pending-challenges-per-IP (`RATE_LIMITED`).
- Sends `challenge { nonce, serverKeyId }`; `auth.proof` must arrive within `proofTimeoutMs` (10 s) → otherwise `CHALLENGE_EXPIRED`.
- The nonce is taken exactly once (`CHALLENGE_EXPIRED` if missing/expired by the injected clock); the signature is verified over `buildAuthMessage(<this server's serverKeyId>, nonce)` (`BAD_SIGNATURE`), which binds the proof to this TLS key.
- Then `admit()` (Task 18). Every credential failure is counted in the per-IP limiter and logged **with the IP** (the only place IPs are logged, spec §7); successes never count. After the `await` the connection state is re-checked (spec §5.1).

**Gateway** — per upgrade: builds a `Connection`; refuses with `error { RATE_LIMITED }` when there are already 256 unauthenticated sockets in total or 20 unauthenticated sockets from the same IP key (authenticated sessions do not count); runs the handshake; registers the session (replacing an older one with `SESSION_REPLACED`) **before** sending `welcome`; then loops over `nextEnvelope()`: 30 requests/s per session (`RATE_LIMITED` response), dispatch, re-check that the session is still current before answering. An invalid frame after authentication closes the socket with `BAD_REQUEST`. `close()` sends `SERVER_SHUTDOWN` to every socket and terminates stragglers after 2 s. `WebSocketServer` runs with `noServer`, `maxPayload: 256 KiB`, `perMessageDeflate: false`.

**HTTP (spec §4)** — `node:https` with `headersTimeout` 10 s and `requestTimeout` 30 s; `GET|HEAD /health` → `{ ok, name, version, protocol: { min, max } }` (`Cache-Control: no-store`); `GET|HEAD /` → `200 OK` with `Access-Control-Allow-Origin: *` (livekit-client's reconnect probe); upgrades only on `/ws`; everything else → empty `404`; `X-Content-Type-Options: nosniff` on all responses.

**`startServer`** — creates the data dir, loads/creates the certificate, opens and migrates the DB (closing it again if anything fails), seeds `server_meta` on first run (sanitized name, default join mode `invite`), stores `publicAddresses` when given (validated, canonical, deduplicated), ensures the setup code, listens (rejecting with the original `EADDRINUSE` error and releasing the DB), and returns the `GhostServer`. `createInvite` uses the stored public addresses, or `127.0.0.1:<port>` when none are configured. `close()` is idempotent.

**Test helpers** — `startTestServer` binds to `127.0.0.1` (never `0.0.0.0`: that triggers a Windows Firewall prompt), uses a fresh temp dir and `silentLogger`, and keeps the production default join mode (`invite`). `connectRaw` opens a `wss://` socket and **pins the serverKeyId on `secureConnect`, before the upgrade request is sent**, via ws's `createConnection` option — the technique the desktop will use (spec §3.3). Notes verified against ws 8.22.0: pass `path: undefined` (a `path` option would make `tls.connect` try an IPC socket), use `servername: undefined` for IP hosts, and cast the function because `@types/ws` types `createConnection` as the overloaded `net.createConnection`. `connectTestClient` runs the whole handshake, signing the **pinned** key id (never the one echoed by the server), and resolves with `welcome` or `error`. `test/helpers/db.ts` opens a second SQLite connection to set states that have no API in M1 (bans, removal, password, `max_members`).

- [ ] **Step 1: Create the test client helper**

`apps/server/test/helpers/testClient.ts`:

```ts
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ClientRequestArgs } from 'node:http';
import { isIP, type createConnection as netCreateConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import WebSocket from 'ws';
import {
  PROTOCOL,
  buildAuthMessage,
  challengeSchemaClient,
  errorEventSchemaClient,
  resSchemaClient,
  welcomeSchemaClient,
  type Envelope,
  type ErrorCode,
  type HelloPayload,
  type ResErr,
  type ResOk,
  type WelcomePayload,
} from '@ghostlink/shared';
import { silentLogger, startServer, type GhostServer, type StartServerOptions } from '../../src/index.js';
import { makeIdentity, type TestIdentity } from './identity.js';

export { makeIdentity, type TestIdentity } from './identity.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface TestServer {
  server: GhostServer;
  dataDir: string;
  url: string;
  cleanup(): Promise<void>;
}

/** Real server on 127.0.0.1 and a random port, in a fresh temp data dir, with a silent logger. */
export async function startTestServer(opts: Partial<StartServerOptions> = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', logger: silentLogger, ...opts, dataDir });
  return {
    server,
    dataDir,
    url: `wss://127.0.0.1:${server.port}/ws`,
    cleanup: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface RawClient {
  ws: WebSocket;
  send(message: unknown): void;
  /** Next JSON message from the server; rejects on timeout or when the socket closes first. */
  next(timeoutMs?: number): Promise<Envelope>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/**
 * Opens a WSS connection that pins the server's serverKeyId on 'secureConnect',
 * before the upgrade request is sent — the same technique as the desktop main
 * process (spec §3.3). A mismatch destroys the socket with code PIN_MISMATCH.
 */
export function connectRaw(
  server: Pick<GhostServer, 'port' | 'serverKeyId'>,
  opts: { pin?: string; autoPong?: boolean; path?: string } = {},
): Promise<RawClient> {
  const pin = opts.pin ?? server.serverKeyId;
  const ws = new WebSocket(`wss://127.0.0.1:${server.port}${opts.path ?? '/ws'}`, {
    perMessageDeflate: false,
    autoPong: opts.autoPong ?? true,
    // @types/ws types this as the overloaded net.createConnection, hence the cast.
    createConnection: ((options: ClientRequestArgs) => {
      const host = String(options.host);
      const socket = tlsConnect({
        ...(options as ConnectionOptions),
        path: undefined,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
      });
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate(true).raw;
        const spki = new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' });
        const got = createHash('sha256').update(spki).digest('base64url');
        if (got !== pin) socket.destroy(Object.assign(new Error('PIN_MISMATCH'), { code: 'PIN_MISMATCH' }));
      });
      return socket;
    }) as unknown as typeof netCreateConnection,
  });

  const queue: Envelope[] = [];
  const waiters: Array<(m: Envelope | null) => void> = [];
  let isClosed = false;
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Envelope;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      isClosed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
      resolve({ code, reason: reason.toString() });
    });
  });

  const client: RawClient = {
    ws,
    send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: (timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (isClosed) return Promise.reject(new Error('socket closed'));
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onMessage);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`no message within ${timeoutMs} ms`));
        }, timeoutMs);
        const onMessage = (m: Envelope | null) => {
          clearTimeout(timer);
          if (m) resolve(m);
          else reject(new Error('socket closed'));
        };
        waiters.push(onMessage);
      });
    },
    closed,
    close: () => ws.close(),
  };

  return new Promise<RawClient>((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

export interface TestClient {
  identity: TestIdentity;
  welcome?: WelcomePayload;
  error?: { code: ErrorCode; min?: number; max?: number };
  raw: RawClient;
  request(t: string, d?: unknown): Promise<ResOk | ResErr>;
  waitEvent(t: string, timeoutMs?: number): Promise<Envelope>;
  close(): void;
}

export interface ConnectTestClientOptions {
  seed?: Uint8Array;
  nickname?: string;
  inviteCode?: string;
  password?: string;
  setupCode?: string;
  protocol?: number;
  locale?: string;
}

/**
 * Runs the full handshake. Resolves with `welcome` set on success, or with
 * `error` set when the server refused (the socket is then closing).
 */
export async function connectTestClient(server: GhostServer, opts: ConnectTestClientOptions = {}): Promise<TestClient> {
  const identity = makeIdentity(opts.seed);
  const raw = await connectRaw(server);
  const hello: HelloPayload = {
    protocol: opts.protocol ?? PROTOCOL.current,
    publicKey: identity.publicKey,
    nickname: opts.nickname ?? `user-${identity.userId.slice(0, 6)}`,
    locale: opts.locale ?? 'pt-BR',
    client: 'ghostlink-test/0.0.0 (test)',
  };
  if (opts.password !== undefined) hello.password = opts.password;
  if (opts.inviteCode !== undefined) hello.inviteCode = opts.inviteCode;
  if (opts.setupCode !== undefined) hello.setupCode = opts.setupCode;
  raw.send({ t: 'hello', d: hello });

  const client: TestClient = {
    identity,
    raw,
    request: () => Promise.reject(new Error('not connected')),
    waitEvent: () => Promise.reject(new Error('not connected')),
    close: () => raw.close(),
  };

  let message = await raw.next();
  if (message.t === 'challenge') {
    const challenge = challengeSchemaClient.parse(message.d);
    // Sign the PINNED key id, never the one echoed by the server (spec §3.3).
    const signature = identity.sign(buildAuthMessage(server.serverKeyId, challenge.nonce));
    raw.send({ t: 'auth.proof', d: { signature: Buffer.from(signature).toString('base64url') } });
    message = await raw.next();
  }
  if (message.t === 'error') {
    client.error = errorEventSchemaClient.parse(message).d;
    return client;
  }
  if (message.t !== 'welcome') throw new Error(`unexpected message ${message.t}`);
  client.welcome = welcomeSchemaClient.parse(message.d);

  // After the welcome: route responses by id, queue everything else as events.
  let nextId = 1;
  const pending = new Map<number, (r: ResOk | ResErr) => void>();
  const events: Envelope[] = [];
  const eventWaiters: Array<{ t: string; resolve: (e: Envelope) => void }> = [];
  void (async () => {
    for (;;) {
      let m: Envelope;
      try {
        m = await raw.next(24 * 3_600_000);
      } catch {
        return;
      }
      if (m.t === 'res') {
        const res = resSchemaClient.parse(m) as ResOk | ResErr;
        pending.get(res.id)?.(res);
        pending.delete(res.id);
        continue;
      }
      const i = eventWaiters.findIndex((w) => w.t === m.t);
      if (i >= 0) eventWaiters.splice(i, 1)[0]!.resolve(m);
      else events.push(m);
    }
  })();

  client.request = (t, d = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no response to ${t}`)), DEFAULT_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    raw.send({ t, id, d });
  });
  client.waitEvent = (t, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const i = events.findIndex((e) => e.t === t);
    if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { t, resolve: (e: Envelope) => { clearTimeout(timer); resolve(e); } };
      const timer = setTimeout(() => {
        const j = eventWaiters.indexOf(waiter);
        if (j >= 0) eventWaiters.splice(j, 1);
        reject(new Error(`no ${t} event within ${timeoutMs} ms`));
      }, timeoutMs);
      eventWaiters.push(waiter);
    });
  };
  return client;
}
```

- [ ] **Step 2: Create the DB test helper**

`apps/server/test/helpers/db.ts`:

```ts
import { join } from 'node:path';
import type { JoinMode } from '@ghostlink/shared';
import { hashPassword } from '../../src/auth/password.js';
import { Db, type Row } from '../../src/db/database.js';

/**
 * Opens a second SQLite connection to a running test server's database.
 * M1 has no admin API yet (server.update, member.ban, … arrive in M3), so tests
 * set up those states directly. The server re-reads the tables on every handshake.
 */
export function withDb<T>(dataDir: string, fn: (db: Db) => T): T {
  const db = new Db(join(dataDir, 'ghostlink.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function setJoinMode(dataDir: string, mode: JoinMode): void {
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET join_mode = ? WHERE id = 1', mode));
}

export async function setPassword(dataDir: string, password: string | null): Promise<void> {
  const hash = password === null ? null : await hashPassword(password);
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET password_hash = ? WHERE id = 1', hash));
}

export function setMaxMembers(dataDir: string, max: number): void {
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET max_members = ? WHERE id = 1', max));
}

export function insertBan(dataDir: string, ban: { userId: string; publicKey?: Uint8Array; ip?: string }): void {
  withDb(dataDir, (db) => db.run(
    'INSERT INTO bans (user_id, public_key, ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ban.userId,
    ban.publicKey ?? null,
    ban.ip ?? null,
    'test',
    'test',
    Date.now(),
  ));
}

export function markRemoved(dataDir: string, userId: string, removedAt: number, rejoinBlockedUntil: number | null): void {
  withDb(dataDir, (db) => db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = ? WHERE id = ?', removedAt, rejoinBlockedUntil, userId));
}

export function getUser(dataDir: string, userId: string): Row | undefined {
  return withDb(dataDir, (db) => db.get('SELECT * FROM users WHERE id = ?', userId));
}

export function getInviteUses(dataDir: string, code: string): number {
  return withDb(dataDir, (db) => Number(db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', code)?.uses ?? -1));
}

export function countUsers(dataDir: string): number {
  return withDb(dataDir, (db) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0));
}

export function getOwner(dataDir: string): string | null {
  return withDb(dataDir, (db) => (db.get<{ owner_user_id: string | null }>('SELECT owner_user_id FROM server_meta WHERE id = 1')?.owner_user_id ?? null));
}
```

- [ ] **Step 3: Write the failing HTTP route tests**

`apps/server/test/integration/http.test.ts`:

```ts
import { request } from 'node:https';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@ghostlink/shared';
import { SERVER_VERSION } from '../../src/index.js';
import { connectRaw, startTestServer, type TestServer } from '../helpers/testClient.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer({ name: 'Casa do Zé' });
});
afterAll(() => t.cleanup());

function http(method: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: t.server.port, method, path, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTPS routes (spec §4)', () => {
  it('GET /health returns only public facts', async () => {
    const res = await http('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({ ok: true, name: 'Casa do Zé', version: SERVER_VERSION, protocol: { min: PROTOCOL.min, max: PROTOCOL.max } });
  });

  it('GET /health ignores the query string', async () => {
    expect((await http('GET', '/health?x=1')).status).toBe(200);
  });

  it('HEAD / and GET / answer 200 with CORS * (livekit-client reconnect probe)', async () => {
    const head = await http('HEAD', '/');
    expect(head.status).toBe(200);
    expect(head.headers['access-control-allow-origin']).toBe('*');
    expect(head.body).toBe('');
    const get = await http('GET', '/');
    expect(get.status).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBe('*');
    expect(get.body).toBe('OK');
  });

  it.each([
    ['GET', '/nope'],
    ['GET', '/files/abc'],
    ['POST', '/'],
    ['POST', '/health'],
    ['DELETE', '/health'],
    ['GET', '/ws'], // plain GET without the upgrade handshake
    ['GET', '/../etc/passwd'],
  ])('%s %s → 404 with no body', async (method, path) => {
    const res = await http(method, path);
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses WebSocket upgrades outside /ws', async () => {
    await expect(connectRaw(t.server, { path: '/other' })).rejects.toThrow();
  });

  it('accepts the /ws upgrade and speaks TLS 1.3 with the pinned key', async () => {
    const raw = await connectRaw(t.server);
    expect(raw.ws.readyState).toBe(raw.ws.OPEN);
    raw.close();
    const socket = connect({ host: '127.0.0.1', port: t.server.port, rejectUnauthorized: false });
    await new Promise<void>((r) => socket.once('secureConnect', () => r()));
    expect(socket.getProtocol()).toBe('TLSv1.3');
    socket.destroy();
  });

  it('a client pinned to another key never reaches the upgrade', async () => {
    await expect(connectRaw(t.server, { pin: 'A'.repeat(43) })).rejects.toMatchObject({ code: 'PIN_MISMATCH' });
  });
});
```

- [ ] **Step 4: Write the failing handshake tests**

`apps/server/test/integration/handshake.test.ts` — success path and welcome contents, protocol negotiation, every malformed-input path, proof of possession (wrong key, **signature bound to serverKeyId**, **replay of a captured proof on a new connection**, **expiry by the injectable clock** and its exact boundary), both deadlines (shortened via `limits`, plus one run of the real 5 s default), `maxPayload`, and post-auth behaviour (unknown types, id-less envelopes, invalid frames, 30 requests/s):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, buildAuthMessage, toBase64Url, type HelloPayload } from '@ghostlink/shared';
import { SERVER_VERSION } from '../../src/index.js';
import { getUser } from '../helpers/db.js';
import {
  connectRaw,
  connectTestClient,
  makeIdentity,
  startTestServer,
  type RawClient,
  type TestIdentity,
  type TestServer,
} from '../helpers/testClient.js';

const servers: TestServer[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

function hello(identity: TestIdentity, overrides: Partial<HelloPayload> = {}): { t: 'hello'; d: HelloPayload } {
  return {
    t: 'hello',
    d: { protocol: PROTOCOL.current, publicKey: identity.publicKey, nickname: 'Ana', locale: 'pt-BR', client: 'test', ...overrides },
  };
}

function proof(identity: TestIdentity, serverKeyId: string, nonce: string) {
  return { t: 'auth.proof', d: { signature: toBase64Url(identity.sign(buildAuthMessage(serverKeyId, nonce))) } };
}

async function expectRefused(raw: RawClient, code: string, timeoutMs = 5_000): Promise<void> {
  const message = await raw.next(timeoutMs);
  expect(message).toMatchObject({ t: 'error', d: { code } });
  expect(await raw.closed).toEqual({ code: 4000, reason: code });
}

describe('successful handshake', () => {
  it('returns a complete welcome and stores the member', async () => {
    const t = await server({ name: 'Servidor' });
    const c = await connectTestClient(t.server, { nickname: '  Ana‮  ', locale: 'en-US' });
    expect(c.error).toBeUndefined();
    const w = c.welcome!;
    expect(w.self).toEqual({ userId: c.identity.userId, nickname: 'Ana', isOwner: false });
    expect(w.server).toEqual({ name: 'Servidor', version: SERVER_VERSION, joinMode: 'open', serverKeyId: t.server.serverKeyId });
    expect(w.protocol).toEqual({ min: PROTOCOL.min, max: PROTOCOL.max });
    expect(w.features).toEqual([]);
    expect(w.fileToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    expect(w.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
    expect(Math.abs(w.serverTime - Date.now())).toBeLessThan(5_000);
    const user = getUser(t.dataDir, c.identity.userId)!;
    expect(user).toMatchObject({ nickname: 'Ana', nickname_norm: 'ana', locale: 'en-US', last_ip: '127.0.0.1', removed_at: null });
    expect(Buffer.from(user.public_key as Uint8Array).equals(Buffer.from(c.identity.publicKeyRaw))).toBe(true);
    c.close();
  });

  it('gives every session fresh sessionId and fileToken', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(7);
    const a = await connectTestClient(t.server, { seed });
    const b = await connectTestClient(t.server, { seed });
    expect(b.welcome!.sessionId).not.toBe(a.welcome!.sessionId);
    expect(b.welcome!.fileToken).not.toBe(a.welcome!.fileToken);
    b.close();
  });

  it('answers ping after authentication with the injected clock', async () => {
    const t = await server({ now: () => 1_234_567 });
    const c = await connectTestClient(t.server);
    expect(await c.request('ping', {})).toEqual({ t: 'res', id: 1, ok: true, d: { t: 1_234_567 } });
    c.close();
  });
});

describe('protocol negotiation', () => {
  it.each([PROTOCOL.max + 1, PROTOCOL.min - 1])('refuses protocol %i with PROTOCOL_UNSUPPORTED and the accepted range', async (protocol) => {
    const t = await server();
    const c = await connectTestClient(t.server, { protocol });
    expect(c.error).toEqual({ code: 'PROTOCOL_UNSUPPORTED', min: PROTOCOL.min, max: PROTOCOL.max });
  });
});

describe('malformed handshakes → BAD_REQUEST', () => {
  it.each([
    ['a request before hello', { t: 'ping', id: 1, d: {} }],
    ['hello with unknown key', { t: 'hello', d: { ...hello(makeIdentity()).d, admin: true } }],
    ['hello without payload', { t: 'hello' }],
    ['hello with 31-byte key', hello(makeIdentity(), { publicKey: toBase64Url(new Uint8Array(31)) })],
    ['hello with the small-order all-zero key', hello(makeIdentity(), { publicKey: toBase64Url(new Uint8Array(32)) })],
    ['hello with an invisible nickname', hello(makeIdentity(), { nickname: '​ㅤ' })],
    ['hello with a 33-grapheme nickname', hello(makeIdentity(), { nickname: 'a'.repeat(33) })],
  ])('%s', async (_label, message) => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(message);
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('invalid JSON', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send('{not json');
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('binary frame', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send(Buffer.from(JSON.stringify(hello(makeIdentity()))), { binary: true });
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('a second hello instead of auth.proof', async () => {
    const t = await server();
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    expect((await raw.next()).t).toBe('challenge');
    raw.send(hello(id));
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('auth.proof with a malformed signature', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    await raw.next();
    raw.send({ t: 'auth.proof', d: { signature: 'short' } });
    await expectRefused(raw, 'BAD_REQUEST');
  });
});

describe('proof of possession (spec §3.3)', () => {
  it('sends a 32-byte single-use nonce and the real serverKeyId', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    const challenge = await raw.next();
    expect(challenge).toMatchObject({ t: 'challenge', d: { serverKeyId: t.server.serverKeyId } });
    expect((challenge.d as { nonce: string }).nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    raw.close();
  });

  it('rejects a signature made with a different key → BAD_SIGNATURE', async () => {
    const t = await server();
    const claimed = makeIdentity();
    const actual = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(claimed));
    const { nonce } = (await raw.next()).d as { nonce: string };
    raw.send(proof(actual, t.server.serverKeyId, nonce));
    await expectRefused(raw, 'BAD_SIGNATURE');
  });

  it('binds the signature to the serverKeyId: a proof made for another server is rejected', async () => {
    const t = await server();
    const other = await server();
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    raw.send(proof(id, other.server.serverKeyId, nonce)); // what a malicious relay would forward
    await expectRefused(raw, 'BAD_SIGNATURE');
  });

  it('a captured proof cannot be replayed on a new connection (fresh nonce)', async () => {
    const t = await server();
    const id = makeIdentity();
    const first = await connectRaw(t.server);
    first.send(hello(id));
    const { nonce } = (await first.next()).d as { nonce: string };
    const captured = proof(id, t.server.serverKeyId, nonce);
    first.close();

    const second = await connectRaw(t.server);
    second.send(hello(id));
    const fresh = (await second.next()).d as { nonce: string };
    expect(fresh.nonce).not.toBe(nonce);
    second.send(captured);
    await expectRefused(second, 'BAD_SIGNATURE');
  });

  it('rejects an expired challenge (injectable clock) → CHALLENGE_EXPIRED', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    clock.t += 30_001;
    raw.send(proof(id, t.server.serverKeyId, nonce));
    await expectRefused(raw, 'CHALLENGE_EXPIRED');
  });

  it('accepts a proof right at the TTL boundary', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    clock.t += 30_000;
    raw.send(proof(id, t.server.serverKeyId, nonce));
    expect((await raw.next()).t).toBe('welcome');
    raw.close();
  });
});

describe('pre-auth deadlines', () => {
  it('closes a connection that never says hello', async () => {
    const t = await server({ limits: { helloTimeoutMs: 150 } });
    const raw = await connectRaw(t.server);
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('closes a connection that never sends auth.proof → CHALLENGE_EXPIRED', async () => {
    const t = await server({ limits: { proofTimeoutMs: 150 } });
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    expect((await raw.next()).t).toBe('challenge');
    await expectRefused(raw, 'CHALLENGE_EXPIRED');
  });

  it('uses the real 5 s hello deadline by default', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    const started = Date.now();
    await expectRefused(raw, 'BAD_REQUEST', 8_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);
});

describe('framing limits', () => {
  it('drops frames over maxPayload (256 KiB) with close code 1009', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send(JSON.stringify({ t: 'hello', d: { pad: 'x'.repeat(256 * 1024) } }));
    expect((await raw.closed).code).toBe(1009);
  });
});

describe('after authentication', () => {
  it('answers unknown request types with BAD_REQUEST and keeps the session', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    expect(await c.request('msg.send', { channelId: 'x' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await c.request('ping')).toMatchObject({ ok: true });
    c.close();
  });

  it('ignores envelopes without id', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    c.raw.send({ t: 'ping', d: {} });
    expect(await c.request('ping')).toMatchObject({ id: 1, ok: true });
    c.close();
  });

  it('closes the session on an invalid frame', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    c.raw.ws.send('garbage');
    expect(await c.waitEvent('error')).toEqual({ t: 'error', d: { code: 'BAD_REQUEST' } });
    expect((await c.raw.closed).reason).toBe('BAD_REQUEST');
  });

  it('limits requests to 30 per second per session', async () => {
    const t = await server({ now: () => 5_000 }); // frozen clock: all requests fall in one window
    const c = await connectTestClient(t.server);
    const results = await Promise.all(Array.from({ length: 31 }, () => c.request('ping')));
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'RATE_LIMITED' }) })]);
    c.close();
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npm test -- apps/server/test/integration/http.test.ts apps/server/test/integration/handshake.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/index.js'`.

- [ ] **Step 6: Implement `auth/handshake.ts`**

```ts
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL,
  ProtocolError,
  authProofSchema,
  buildAuthMessage,
  fromBase64Url,
  helloSchema,
  negotiateProtocol,
  normalizeNickname,
  type Envelope,
  type ErrorCode,
  type HelloPayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import type { ServerLimits } from '../limits.js';
import type { Logger } from '../logger.js';
import type { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { ConnectionClosedError, type Connection } from '../ws/connection.js';
import { admit } from './admission.js';
import type { ChallengeStore } from './challenges.js';
import { isWeakPublicKey, userIdFromPublicKey, verifyAuthSignature } from './identity.js';

export interface AuthedSession {
  userId: string;
  sessionId: string;
  nickname: string;
  isOwner: boolean;
  fileToken: string;
  locale: string;
}

export interface HandshakeDeps {
  db: Db;
  dataDir: string;
  serverKeyId: string;
  limits: ServerLimits;
  now: () => number;
  challenges: ChallengeStore;
  authFailures: SlidingWindowLimiter;
  newIdentities: SlidingWindowLimiter;
  logger: Logger;
}

/** Thrown after the connection was already closed with `code`. */
export class HandshakeFailed extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'HandshakeFailed';
  }
}

/**
 * hello → challenge → auth.proof → admission (spec §3.3). Resolves with the
 * session once the identity is admitted; otherwise closes the connection with
 * the matching error code and rejects with HandshakeFailed. Credential failures
 * (bad input, bad signature, expired challenge, bad password/invite/setup code,
 * ban, deadline) count toward the per-IP auth-failure limit; successes never do.
 */
export async function runHandshake(conn: Connection, deps: HandshakeDeps): Promise<AuthedSession> {
  const fail = (code: ErrorCode, opts: { counts: boolean; extra?: { min: number; max: number } }): HandshakeFailed => {
    if (opts.counts) {
      deps.authFailures.hit(conn.ipKey);
      deps.logger.warn('authentication failed', { ip: conn.ip, code }); // spec §7: IPs are logged only for auth failures
    }
    deps.challenges.drop(conn.id);
    conn.close(code, opts.extra);
    return new HandshakeFailed(code);
  };

  const next = async (): Promise<Envelope> => {
    try {
      return await conn.nextEnvelope();
    } catch (e) {
      if (e instanceof ProtocolError) throw fail('BAD_REQUEST', { counts: true });
      if (e instanceof ConnectionClosedError) throw new HandshakeFailed('BAD_REQUEST');
      throw e;
    }
  };

  // ---- hello ----
  conn.setDeadline(deps.limits.helloTimeoutMs, () => fail('BAD_REQUEST', { counts: true }));
  const helloEnvelope = await next();
  if (!deps.authFailures.peek(conn.ipKey)) throw fail('RATE_LIMITED', { counts: false });
  if (helloEnvelope.t !== 'hello') throw fail('BAD_REQUEST', { counts: true });
  const parsed = helloSchema.safeParse(helloEnvelope.d);
  if (!parsed.success) throw fail('BAD_REQUEST', { counts: true });
  const hello: HelloPayload = parsed.data;
  if (!negotiateProtocol(hello.protocol, PROTOCOL)) {
    throw fail('PROTOCOL_UNSUPPORTED', { counts: false, extra: { min: PROTOCOL.min, max: PROTOCOL.max } });
  }
  let publicKey: Uint8Array;
  let nickname: { display: string; norm: string };
  try {
    publicKey = fromBase64Url(hello.publicKey);
    nickname = normalizeNickname(hello.nickname);
  } catch {
    throw fail('BAD_REQUEST', { counts: true });
  }
  if (publicKey.length !== 32 || isWeakPublicKey(publicKey)) throw fail('BAD_REQUEST', { counts: true });

  const nonce = deps.challenges.issue(conn.id, conn.ipKey);
  if (nonce === null) throw fail('RATE_LIMITED', { counts: false });
  conn.state = 'awaiting-proof';
  conn.send({ t: 'challenge', d: { nonce, serverKeyId: deps.serverKeyId } });

  // ---- auth.proof ----
  conn.setDeadline(deps.limits.proofTimeoutMs, () => fail('CHALLENGE_EXPIRED', { counts: true }));
  const proofEnvelope = await next();
  if (proofEnvelope.t !== 'auth.proof') throw fail('BAD_REQUEST', { counts: true });
  const proof = authProofSchema.safeParse(proofEnvelope.d);
  if (!proof.success) throw fail('BAD_REQUEST', { counts: true });
  const challenge = deps.challenges.take(conn.id);
  if (!challenge.ok) throw fail('CHALLENGE_EXPIRED', { counts: true });
  const message = buildAuthMessage(deps.serverKeyId, challenge.nonce);
  if (!verifyAuthSignature(publicKey, message, fromBase64Url(proof.data.signature))) {
    throw fail('BAD_SIGNATURE', { counts: true });
  }

  // ---- membership ----
  // The proof arrived in time; admission is server-side work (bounded by the scrypt queue).
  conn.clearDeadline();
  const userId = userIdFromPublicKey(publicKey);
  const result = await admit(
    {
      userId,
      publicKey,
      nickname,
      locale: hello.locale,
      ip: conn.ip,
      ipKey: conn.ipKey,
      password: hello.password,
      inviteCode: hello.inviteCode,
      setupCode: hello.setupCode,
    },
    { db: deps.db, dataDir: deps.dataDir, now: deps.now, newIdentities: deps.newIdentities },
  );
  // Re-check after the await (spec §5.1): the socket may have closed while scrypt ran.
  if (conn.closed) throw new HandshakeFailed('BAD_REQUEST');
  if (!result.ok) throw fail(result.code, { counts: result.countsAsFailure });

  conn.state = 'authenticated';
  return {
    userId: result.user.id,
    sessionId: randomBytes(16).toString('base64url'),
    nickname: result.user.nickname,
    isOwner: result.user.isOwner,
    fileToken: randomBytes(32).toString('base64url'),
    locale: hello.locale,
  };
}
```

- [ ] **Step 7: Implement `ws/gateway.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { PROTOCOL, ProtocolError, type Envelope, type WelcomePayload } from '@ghostlink/shared';
import { ChallengeStore } from '../auth/challenges.js';
import { HandshakeFailed, runHandshake, type AuthedSession } from '../auth/handshake.js';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';
import type { ServerLimits } from '../limits.js';
import type { Logger } from '../logger.js';
import { SlidingWindowLimiter, ipKey } from '../ratelimit/limiter.js';
import { Connection, ConnectionClosedError } from './connection.js';
import { M1_HANDLERS, createDispatcher, errorResponse } from './dispatch.js';
import { SessionRegistry, type SessionHandle } from './sessions.js';

export interface GatewayDeps {
  db: Db;
  dataDir: string;
  serverKeyId: string;
  version: string;
  limits: ServerLimits;
  now: () => number;
  logger: Logger;
}

const SWEEP_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Owns every WebSocket: pre-auth admission limits (spec §13), the handshake,
 * the one-session-per-identity registry and the post-auth request loop.
 */
export class Gateway {
  readonly sessions = new SessionRegistry();
  readonly #deps: GatewayDeps;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #unauthenticatedPerIp = new Map<string, number>();
  #unauthenticated = 0;
  #closing = false;
  readonly #challenges: ChallengeStore;
  readonly #authFailures: SlidingWindowLimiter;
  readonly #newIdentities: SlidingWindowLimiter;
  readonly #sweepTimer: NodeJS.Timeout;
  readonly #dispatch: ReturnType<typeof createDispatcher>;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    const { limits, now } = deps;
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: limits.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#challenges = new ChallengeStore({ ttlMs: limits.challengeTtlMs, maxPendingPerIp: limits.pendingChallengesPerIp, now });
    this.#authFailures = new SlidingWindowLimiter(limits.authFailuresPerIpPerMinute, 60_000, now);
    this.#newIdentities = new SlidingWindowLimiter(limits.newIdentitiesPerIpPerHour, 3_600_000, now);
    this.#dispatch = createDispatcher(M1_HANDLERS, deps.logger);
    this.#sweepTimer = setInterval(() => {
      this.#authFailures.sweep();
      this.#newIdentities.sweep();
    }, SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref();
  }

  get stats(): { connections: number; unauthenticated: number; sessions: number } {
    return { connections: this.#connections.size, unauthenticated: this.#unauthenticated, sessions: this.sessions.size };
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const { limits } = this.#deps;
      const conn = new Connection(ws, { ip, ipKey: ipKey(ip), pingIntervalMs: limits.pingIntervalMs, pongTimeoutMs: limits.pongTimeoutMs });
      this.#connections.add(conn);
      conn.onClose(() => this.#connections.delete(conn));
      const perIp = this.#unauthenticatedPerIp.get(conn.ipKey) ?? 0;
      if (this.#unauthenticated >= limits.maxUnauthenticatedConnections || perIp >= limits.maxConnectionsPerIp) {
        conn.close('RATE_LIMITED');
        return;
      }
      void this.#serve(conn);
    });
  }

  /** Graceful shutdown: every socket gets `error { SERVER_SHUTDOWN }`, stragglers are terminated. */
  async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#sweepTimer);
    const pending = [...this.#connections].map((conn) => new Promise<void>((resolve) => {
      conn.onClose(resolve);
      conn.close('SERVER_SHUTDOWN');
    }));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([Promise.all(pending), timeout]);
    for (const conn of this.#connections) conn.terminate();
    this.#wss.close();
  }

  async #serve(conn: Connection): Promise<void> {
    const releaseUnauthenticated = this.#trackUnauthenticated(conn.ipKey);
    conn.onClose(releaseUnauthenticated);
    let session: AuthedSession;
    try {
      session = await runHandshake(conn, {
        db: this.#deps.db,
        dataDir: this.#deps.dataDir,
        serverKeyId: this.#deps.serverKeyId,
        limits: this.#deps.limits,
        now: this.#deps.now,
        challenges: this.#challenges,
        authFailures: this.#authFailures,
        newIdentities: this.#newIdentities,
        logger: this.#deps.logger,
      });
    } catch (e) {
      if (!(e instanceof HandshakeFailed)) {
        this.#deps.logger.error('handshake crashed', { error: String(e) });
        conn.close('INTERNAL');
      }
      return;
    } finally {
      this.#challenges.drop(conn.id);
      releaseUnauthenticated();
    }
    if (this.#closing) {
      conn.close('SERVER_SHUTDOWN');
      return;
    }
    await this.#runSession(conn, session);
  }

  async #runSession(conn: Connection, session: AuthedSession): Promise<void> {
    const handle: SessionHandle = { userId: session.userId, sessionId: session.sessionId, terminate: (code) => conn.close(code) };
    this.sessions.add(handle); // closes an older session of the same identity with SESSION_REPLACED
    conn.onClose(() => this.sessions.remove(handle));
    const meta = getMeta(this.#deps.db);
    const welcome: WelcomePayload = {
      self: { userId: session.userId, nickname: session.nickname, isOwner: session.isOwner },
      sessionId: session.sessionId,
      serverTime: this.#deps.now(),
      server: { name: meta.name, version: this.#deps.version, joinMode: meta.joinMode, serverKeyId: this.#deps.serverKeyId },
      features: [],
      fileToken: session.fileToken,
      protocol: { min: PROTOCOL.min, max: PROTOCOL.max },
    };
    conn.send({ t: 'welcome', d: welcome });

    const perSecond = new SlidingWindowLimiter(this.#deps.limits.requestsPerSecondPerSession, 1_000, this.#deps.now);
    for (;;) {
      let envelope: Envelope;
      try {
        envelope = await conn.nextEnvelope();
      } catch (e) {
        if (e instanceof ProtocolError) conn.close('BAD_REQUEST');
        else if (!(e instanceof ConnectionClosedError)) throw e;
        return;
      }
      if (!this.sessions.isCurrent(handle)) return;
      if (envelope.id !== undefined && !perSecond.hit('requests')) {
        conn.send(errorResponse(envelope.id, 'RATE_LIMITED'));
        continue;
      }
      const response = await this.#dispatch({ userId: session.userId, sessionId: session.sessionId, now: this.#deps.now }, envelope);
      // Re-check after the await: the session may have been replaced or closed meanwhile (spec §5.1).
      if (response && this.sessions.isCurrent(handle)) conn.send(response);
    }
  }

  /** Counts a connection as unauthenticated until the returned function runs (idempotent). */
  #trackUnauthenticated(key: string): () => void {
    this.#unauthenticated++;
    this.#unauthenticatedPerIp.set(key, (this.#unauthenticatedPerIp.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#unauthenticated--;
      const left = (this.#unauthenticatedPerIp.get(key) ?? 1) - 1;
      if (left > 0) this.#unauthenticatedPerIp.set(key, left);
      else this.#unauthenticatedPerIp.delete(key);
    };
  }
}
```

- [ ] **Step 8: Implement `http/server.ts`**

```ts
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { PROTOCOL } from '@ghostlink/shared';

export interface HttpServerDeps {
  certPem: string;
  keyPem: string;
  /** Public, non-sensitive facts for /health. */
  health: () => { name: string; version: string };
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

function route(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): void {
  const path = pathOf(req.url);
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (path === '/health' && readOnly) {
    const { name, version } = deps.health();
    const body = JSON.stringify({ ok: true, name, version, protocol: { min: PROTOCOL.min, max: PROTOCOL.max } });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (path === '/' && readOnly) {
    // livekit-client HEADs the origin to decide when to reconnect (spec §4).
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2 });
    res.end(req.method === 'HEAD' ? undefined : 'OK');
    return;
  }
  res.writeHead(404, { 'Content-Length': 0 });
  res.end();
}

/** HTTPS server with /health, HEAD|GET / and the /ws upgrade; everything else is 404 (spec §4). */
export function createHttpServer(deps: HttpServerDeps): Server {
  const server = createServer(
    { cert: deps.certPem, key: deps.keyPem, headersTimeout: 10_000, requestTimeout: 30_000 },
    (req, res) => route(deps, req, res),
  );
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(req.url) === '/ws') {
      deps.onUpgrade(req, socket, head);
      return;
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}
```

- [ ] **Step 9: Implement `index.ts` (public API, contract §4)**

`limits` is the one addition to the contract's `StartServerOptions` (tests only; see Contract notes).

```ts
import type { AddressInfo } from 'node:net';
import { formatHostPort, parseHostPort, sanitizeLabel, type JoinMode } from '@ghostlink/shared';
import { ensureSetupCode } from './auth/setupCode.js';
import { ensureDataDirs } from './config/paths.js';
import { Db } from './db/database.js';
import { ensureMeta, getMeta, setPublicAddresses } from './db/serverMeta.js';
import { createHttpServer } from './http/server.js';
import { buildInviteInfo, createInvite, type InviteInfo } from './invites/invites.js';
import { resolveLimits, type ServerLimits } from './limits.js';
import { consoleLogger, type Logger } from './logger.js';
import { loadOrCreateCertificate } from './tls/certificate.js';
import { SERVER_VERSION } from './version.js';
import { Gateway } from './ws/gateway.js';

export type { InviteInfo } from './invites/invites.js';
export type { Logger } from './logger.js';
export type { ServerLimits } from './limits.js';
export { consoleLogger, silentLogger } from './logger.js';
export { SERVER_VERSION, WEB_SITE_BASE } from './version.js';

export interface StartServerOptions {
  dataDir: string; // created if missing
  port: number; // 0 = random (tests)
  host?: string; // default '0.0.0.0'
  name?: string; // used only on first run (seeds server_meta.name)
  publicAddresses?: string[]; // overrides server_meta.public_addresses when given
  joinMode?: JoinMode; // first run only; default 'invite'
  logger?: Logger;
  now?: () => number; // injectable clock for tests
  limits?: Partial<ServerLimits>; // tests only: shrink timeouts and caps
}

export interface GhostServer {
  readonly port: number; // actual bound port
  readonly serverKeyId: string;
  readonly version: string;
  readonly dataDir: string;
  setupCode(): string | null; // null once consumed
  createInvite(opts?: { maxUses?: number; expiresInHours?: number; createdBy?: string }): InviteInfo;
  close(): Promise<void>; // graceful: closes WS with SERVER_SHUTDOWN, HTTP, DB
}

const DEFAULT_NAME = 'GhostLink';

/** Validates and canonicalizes "host:port" strings; throws ProtocolError('BAD_REQUEST'). */
function normalizeAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    const { host, port } = parseHostPort(a.trim());
    const canonical = formatHostPort(host, port);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export async function startServer(opts: StartServerOptions): Promise<GhostServer> {
  const logger = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const limits = resolveLimits(opts.limits);
  const paths = ensureDataDirs(opts.dataDir);
  const certificate = await loadOrCreateCertificate(opts.dataDir);

  const db = new Db(paths.db);
  try {
    db.migrate();
    ensureMeta(db, {
      name: sanitizeLabel(opts.name ?? DEFAULT_NAME, 64) || DEFAULT_NAME,
      joinMode: opts.joinMode ?? 'invite',
      now: now(),
    });
    if (opts.publicAddresses !== undefined) setPublicAddresses(db, normalizeAddresses(opts.publicAddresses));
    ensureSetupCode(db, opts.dataDir);
  } catch (e) {
    db.close();
    throw e;
  }

  const gateway = new Gateway({
    db,
    dataDir: opts.dataDir,
    serverKeyId: certificate.serverKeyId,
    version: SERVER_VERSION,
    limits,
    now,
    logger,
  });
  const http = createHttpServer({
    certPem: certificate.certPem,
    keyPem: certificate.keyPem,
    health: () => ({ name: getMeta(db).name, version: SERVER_VERSION }),
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    await gateway.close();
    db.close();
    throw e;
  }
  const port = (http.address() as AddressInfo).port;
  logger.info('GhostLink server listening', { port, version: SERVER_VERSION });

  const effectiveAddresses = (): string[] => {
    const stored = getMeta(db).publicAddresses;
    return stored.length > 0 ? stored : [`127.0.0.1:${port}`];
  };

  let closing: Promise<void> | null = null;
  return {
    port,
    serverKeyId: certificate.serverKeyId,
    version: SERVER_VERSION,
    dataDir: opts.dataDir,
    setupCode: () => ensureSetupCode(db, opts.dataDir),
    createInvite: (o = {}) => {
      const { code } = createInvite(db, { ...o, now: now() });
      return buildInviteInfo(code, { addresses: effectiveAddresses(), serverKeyId: certificate.serverKeyId, name: getMeta(db).name });
    },
    close: () => {
      closing ??= (async () => {
        await gateway.close();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
        db.close();
        logger.info('GhostLink server stopped');
      })();
      return closing;
    },
  };
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -- apps/server/test/integration/http.test.ts apps/server/test/integration/handshake.test.ts`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  43 passed (43)`. One test deliberately waits for the real 5 s hello deadline, so the run takes about 7 s.

- [ ] **Step 11: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0, no output from `tsc` or ESLint.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/auth/handshake.ts apps/server/src/ws/gateway.ts apps/server/src/http/server.ts apps/server/src/index.ts apps/server/test/helpers/testClient.ts apps/server/test/helpers/db.ts apps/server/test/integration/http.test.ts apps/server/test/integration/handshake.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add handshake, WebSocket gateway, HTTPS routes and startServer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: End-to-end membership suite (join modes, invites, ownership, bans)

**Files:**
- Test: `apps/server/test/integration/membership.test.ts`

This task adds **acceptance coverage over the wire** for behaviour implemented in Tasks 12, 15, 18 and 19 (spec §14 "modos de entrada, convites (inclusive corrida de consumo e `max_members`), setup code dispensando convite"). Highlights: the **concurrent-consumption race** (two identities, one `maxUses=1` invite, five rounds → exactly one `welcome` and one `INVITE_INVALID` each time, `uses` stays 1), the **setup-code race** (exactly one owner, the loser's insert rolled back), `NICK_TAKEN`/`SERVER_FULL` not consuming the invite, the per-IP new-identity limit using the socket's remote address, and the kick flow (`REJOIN_BLOCKED` → `INVITE_REQUIRED` → reactivation of the same `userId`).

- [ ] **Step 1: Write the suite**

`apps/server/test/integration/membership.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../../src/config/paths.js';
import {
  countUsers,
  getInviteUses,
  getOwner,
  getUser,
  insertBan,
  markRemoved,
  setJoinMode,
  setMaxMembers,
  setPassword,
  withDb,
} from '../helpers/db.js';
import { connectTestClient, makeIdentity, startTestServer, type TestServer } from '../helpers/testClient.js';

const servers: TestServer[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

describe('invite mode (default)', () => {
  it('is the default join mode', async () => {
    const t = await server();
    const c = await connectTestClient(t.server, { inviteCode: t.server.createInvite().code });
    expect(c.welcome?.server.joinMode).toBe('invite');
    c.close();
  });

  it('requires an invite for a new identity → INVITE_REQUIRED', async () => {
    const t = await server();
    expect((await connectTestClient(t.server)).error?.code).toBe('INVITE_REQUIRED');
    expect(countUsers(t.dataDir)).toBe(0);
  });

  it.each([
    ['unknown code', 'AAAAAAAAAA'],
    ['malformed code', 'not-a-code!'],
  ])('refuses an %s → INVITE_INVALID', async (_label, code) => {
    const t = await server();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('accepts a valid code (any case) and consumes exactly one use', async () => {
    const t = await server();
    const { code } = t.server.createInvite({ maxUses: 5 });
    const c = await connectTestClient(t.server, { inviteCode: code.toLowerCase() });
    expect(c.welcome).toBeDefined();
    expect(getInviteUses(t.dataDir, code)).toBe(1);
    c.close();
  });

  it('lets an existing member back in without an invite and without consuming one', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    const { code } = t.server.createInvite();
    (await connectTestClient(t.server, { seed, inviteCode: code })).close();
    const again = await connectTestClient(t.server, { seed });
    expect(again.welcome).toBeDefined();
    const withCode = await connectTestClient(t.server, { seed, inviteCode: code });
    expect(withCode.welcome).toBeDefined();
    expect(getInviteUses(t.dataDir, code)).toBe(1);
    withCode.close();
  });

  it('refuses an exhausted invite (max_uses) → INVITE_INVALID', async () => {
    const t = await server();
    const { code } = t.server.createInvite({ maxUses: 1 });
    (await connectTestClient(t.server, { inviteCode: code })).close();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
    expect(getInviteUses(t.dataDir, code)).toBe(1);
  });

  it('refuses an expired invite (injectable clock) → INVITE_INVALID', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const { code } = t.server.createInvite({ expiresInHours: 1 });
    clock.t += 3_600_000;
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('refuses a revoked invite → INVITE_INVALID', async () => {
    const t = await server();
    const { code } = t.server.createInvite();
    withDb(t.dataDir, (db) => db.run('UPDATE invites SET revoked = 1 WHERE code = ?', code));
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('consumes a maxUses=1 invite exactly once when two identities race for it', async () => {
    const t = await server();
    for (let round = 0; round < 5; round++) {
      const { code } = t.server.createInvite({ maxUses: 1 });
      const [a, b] = await Promise.all([
        connectTestClient(t.server, { inviteCode: code, nickname: `a${round}` }),
        connectTestClient(t.server, { inviteCode: code, nickname: `b${round}` }),
      ]);
      const outcomes = [a, b].map((c) => (c.welcome ? 'welcome' : c.error?.code)).sort();
      expect(outcomes).toEqual(['INVITE_INVALID', 'welcome']);
      expect(getInviteUses(t.dataDir, code)).toBe(1);
      a.close();
      b.close();
    }
    expect(countUsers(t.dataDir)).toBe(5);
  });

  it('does not consume the invite when the nickname is taken → NICK_TAKEN', async () => {
    const t = await server();
    (await connectTestClient(t.server, { nickname: 'Ana', inviteCode: t.server.createInvite().code })).close();
    const { code } = t.server.createInvite({ maxUses: 1 });
    const clash = await connectTestClient(t.server, { nickname: 'ＡＮＡ', inviteCode: code }); // fullwidth → "ANA" → "ana"
    expect(clash.error?.code).toBe('NICK_TAKEN');
    expect(getInviteUses(t.dataDir, code)).toBe(0);
    const retry = await connectTestClient(t.server, { nickname: 'Ana#2', inviteCode: code });
    expect(retry.welcome?.self.nickname).toBe('Ana#2');
    retry.close();
  });

  it('does not consume the invite when the server is full → SERVER_FULL', async () => {
    const t = await server();
    const member = new Uint8Array(32).fill(3);
    (await connectTestClient(t.server, { seed: member, inviteCode: t.server.createInvite().code })).close();
    setMaxMembers(t.dataDir, 1);
    const { code } = t.server.createInvite();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('SERVER_FULL');
    expect(getInviteUses(t.dataDir, code)).toBe(0);
    const back = await connectTestClient(t.server, { seed: member }); // members still get in
    expect(back.welcome).toBeDefined();
    back.close();
  });
});

describe('open mode', () => {
  it('admits anyone with the address, without consuming anything', async () => {
    const t = await server({ joinMode: 'open' });
    const c = await connectTestClient(t.server);
    expect(c.welcome?.server.joinMode).toBe('open');
    c.close();
  });

  it(`limits new identities to 5 per IP per hour; members are not affected`, async () => {
    const clock = { t: Date.now() };
    const t = await server({ joinMode: 'open', now: () => clock.t });
    const first = new Uint8Array(32).fill(9);
    for (let i = 0; i < 5; i++) {
      const c = await connectTestClient(t.server, i === 0 ? { seed: first } : {});
      expect(c.welcome, `identity ${i}`).toBeDefined();
      c.close();
    }
    expect((await connectTestClient(t.server)).error?.code).toBe('RATE_LIMITED');
    expect((await connectTestClient(t.server, { seed: first })).welcome).toBeDefined();
    clock.t += 3_600_001;
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });
});

describe('password mode', () => {
  it('asks for the password only on first access', async () => {
    const t = await server({ joinMode: 'password' });
    await setPassword(t.dataDir, 'segredo');
    const seed = new Uint8Array(32).fill(4);
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('BAD_PASSWORD');
    expect((await connectTestClient(t.server, { seed, password: 'Segredo' })).error?.code).toBe('BAD_PASSWORD');
    const ok = await connectTestClient(t.server, { seed, password: 'segredo' });
    expect(ok.welcome?.server.joinMode).toBe('password');
    ok.close();
    const again = await connectTestClient(t.server, { seed });
    expect(again.welcome).toBeDefined();
    again.close();
  });

  it('refuses everyone new while no password is configured', async () => {
    const t = await server({ joinMode: 'password' });
    expect((await connectTestClient(t.server, { password: 'anything' })).error?.code).toBe('BAD_PASSWORD');
  });

  it('changing the join mode never kicks existing members', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(5);
    (await connectTestClient(t.server, { seed })).close();
    setJoinMode(t.dataDir, 'password');
    await setPassword(t.dataDir, 'x');
    const c = await connectTestClient(t.server, { seed });
    expect(c.welcome).toBeDefined();
    c.close();
  });
});

describe('setup code → owner (spec §3.3)', () => {
  it('bypasses the invite and makes the first identity the owner; the code is then burned', async () => {
    const t = await server();
    const code = t.server.setupCode()!;
    const owner = await connectTestClient(t.server, { setupCode: code });
    expect(owner.welcome?.self.isOwner).toBe(true);
    expect(getOwner(t.dataDir)).toBe(owner.identity.userId);
    expect(t.server.setupCode()).toBeNull();
    expect(existsSync(dataPaths(t.dataDir).setupCodeFile)).toBe(false);
    owner.close();
    const again = await connectTestClient(t.server, { seed: owner.identity.seed });
    expect(again.welcome?.self.isOwner).toBe(true);
    again.close();
    expect((await connectTestClient(t.server, { setupCode: code })).error?.code).toBe('BAD_SETUP_CODE');
  });

  it('bypasses password and max_members', async () => {
    const t = await server({ joinMode: 'password' });
    await setPassword(t.dataDir, 'pw');
    (await connectTestClient(t.server, { password: 'pw' })).close();
    setMaxMembers(t.dataDir, 1);
    const owner = await connectTestClient(t.server, { setupCode: t.server.setupCode()! });
    expect(owner.welcome?.self.isOwner).toBe(true);
    owner.close();
  });

  it('refuses a wrong setup code → BAD_SETUP_CODE, without falling back to other checks', async () => {
    const t = await server({ joinMode: 'open' });
    const c = await connectTestClient(t.server, { setupCode: '00000000-00000000-00000000-00000000' });
    expect(c.error?.code).toBe('BAD_SETUP_CODE');
    expect(countUsers(t.dataDir)).toBe(0);
  });

  it('lets an existing member claim ownership with the code', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(6);
    const member = await connectTestClient(t.server, { seed });
    expect(member.welcome?.self.isOwner).toBe(false);
    member.close();
    const owner = await connectTestClient(t.server, { seed, setupCode: t.server.setupCode()! });
    expect(owner.welcome?.self.isOwner).toBe(true);
    owner.close();
  });

  it('two identities racing with the same code: exactly one becomes owner', async () => {
    const t = await server();
    const code = t.server.setupCode()!;
    const results = await Promise.all([
      connectTestClient(t.server, { setupCode: code, nickname: 'one' }),
      connectTestClient(t.server, { setupCode: code, nickname: 'two' }),
    ]);
    const owners = results.filter((c) => c.welcome?.self.isOwner);
    expect(owners).toHaveLength(1);
    expect(results.find((c) => !c.welcome)?.error?.code).toBe('BAD_SETUP_CODE');
    expect(getOwner(t.dataDir)).toBe(owners[0]!.identity.userId);
    expect(countUsers(t.dataDir)).toBe(1); // the loser's insert was rolled back
    for (const c of results) c.close();
  });
});

describe('bans and removal', () => {
  it('refuses a banned identity, even an existing member → BANNED', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(7);
    const c = await connectTestClient(t.server, { seed });
    c.close();
    insertBan(t.dataDir, { userId: c.identity.userId, publicKey: c.identity.publicKeyRaw });
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('BANNED');
  });

  it('refuses any identity from a banned IP → BANNED', async () => {
    const t = await server({ joinMode: 'open' });
    insertBan(t.dataDir, { userId: 'someone-else', ip: '127.0.0.1' });
    expect((await connectTestClient(t.server)).error?.code).toBe('BANNED');
  });

  it('blocks a removed member until rejoin_blocked_until → REJOIN_BLOCKED, then requires a new invite', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const seed = new Uint8Array(32).fill(8);
    const c = await connectTestClient(t.server, { seed, inviteCode: t.server.createInvite().code });
    c.close();
    markRemoved(t.dataDir, c.identity.userId, clock.t, clock.t + 600_000); // kicked (spec §7)
    const fresh = t.server.createInvite({ maxUses: 1 });
    expect((await connectTestClient(t.server, { seed, inviteCode: fresh.code })).error?.code).toBe('REJOIN_BLOCKED');
    expect(getInviteUses(t.dataDir, fresh.code)).toBe(0);
    clock.t += 600_001;
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('INVITE_REQUIRED');
    const back = await connectTestClient(t.server, { seed, inviteCode: fresh.code });
    expect(back.welcome?.self.userId).toBe(c.identity.userId);
    expect(getUser(t.dataDir, c.identity.userId)).toMatchObject({ removed_at: null, rejoin_blocked_until: null });
    expect(getInviteUses(t.dataDir, fresh.code)).toBe(1);
    back.close();
  });

  it('a returning member does not count as a new identity for the per-IP limit', async () => {
    const clock = { t: Date.now() };
    const t = await server({ joinMode: 'open', now: () => clock.t });
    const seeds = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(20 + i));
    for (const seed of seeds) (await connectTestClient(t.server, { seed })).close();
    markRemoved(t.dataDir, makeIdentity(seeds[0]).userId, clock.t, null);
    const back = await connectTestClient(t.server, { seed: seeds[0] });
    expect(back.welcome).toBeDefined();
    back.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- apps/server/test/integration/membership.test.ts`
Expected: PASS — `Tests  26 passed (26)`. These tests encode the spec; if one fails, fix the implementation (most likely the argument wiring between `runHandshake` and `admit`), never the assertion.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/integration/membership.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover join modes, invites and ownership end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: End-to-end rate-limit suite

**Files:**
- Test: `apps/server/test/integration/limits.test.ts`

Acceptance coverage for spec §13 pre-auth and auth limits over real sockets: 20 unauthenticated connections per IP (the 21st gets `RATE_LIMITED`; the slot is freed when a socket closes — the test polls instead of sleeping), authenticated sessions not counting toward that cap, the global 256 cap (shrunk to 3 via `limits`), 5 pending challenges per IP, **10 auth failures per minute per IP counting only failures** (15 successful logins do not trip it; `PROTOCOL_UNSUPPORTED` is not a failure; after 10 `BAD_SIGNATURE`s even valid credentials get `RATE_LIMITED` until the injected clock moves past the minute), wrong invite codes counting (no brute force), and the heartbeat (a peer that stops answering pings is dropped; a responsive one stays).

- [ ] **Step 1: Write the suite**

`apps/server/test/integration/limits.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import {
  connectRaw,
  connectTestClient,
  makeIdentity,
  startTestServer,
  type RawClient,
  type TestServer,
} from '../helpers/testClient.js';

const servers: TestServer[] = [];
const sockets: RawClient[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
async function raw(t: TestServer): Promise<RawClient> {
  const r = await connectRaw(t.server);
  sockets.push(r);
  return r;
}
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

async function failOnce(t: TestServer): Promise<void> {
  const id = makeIdentity();
  const r = await raw(t);
  r.send({ t: 'hello', d: { protocol: PROTOCOL.current, publicKey: id.publicKey, nickname: 'x', locale: 'en', client: 't' } });
  const { nonce } = (await r.next()).d as { nonce: string };
  const wrong = makeIdentity();
  r.send({ t: 'auth.proof', d: { signature: toBase64Url(wrong.sign(buildAuthMessage(t.server.serverKeyId, nonce))) } });
  expect(await r.next()).toMatchObject({ t: 'error', d: { code: 'BAD_SIGNATURE' } });
}

describe('pre-auth connection limits (spec §13)', () => {
  it('allows 20 unauthenticated connections per IP and refuses the 21st with RATE_LIMITED', async () => {
    const t = await server();
    const open = await Promise.all(Array.from({ length: 20 }, () => raw(t)));
    const extra = await raw(t);
    expect(await extra.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
    open[0]!.close();
    await open[0]!.closed;
    // The server frees the slot when it sees the close; poll briefly instead of guessing a delay.
    let reply = '';
    for (let attempt = 0; attempt < 40 && reply !== 'challenge'; attempt++) {
      const again = await raw(t);
      again.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: `n${attempt}`, locale: 'en', client: 't' } });
      const m = await again.next();
      reply = m.t === 'error' ? (m.d as { code: string }).code : m.t;
      if (reply !== 'challenge') {
        expect(reply).toBe('RATE_LIMITED');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(reply).toBe('challenge');
  });

  it('authenticated sessions do not count toward the unauthenticated per-IP limit', async () => {
    const t = await server({ limits: { maxConnectionsPerIp: 2 } });
    const a = await connectTestClient(t.server);
    const b = await connectTestClient(t.server);
    expect(a.welcome && b.welcome).toBeTruthy();
    const c = await connectTestClient(t.server);
    expect(c.welcome).toBeDefined();
    for (const x of [a, b, c]) x.close();
  });

  it('caps unauthenticated connections globally', async () => {
    const t = await server({ limits: { maxUnauthenticatedConnections: 3, maxConnectionsPerIp: 100 } });
    await Promise.all([raw(t), raw(t), raw(t)]);
    const extra = await raw(t);
    expect(await extra.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
  });

  it('limits pending challenges per IP to 5', async () => {
    const t = await server();
    for (let i = 0; i < 5; i++) {
      const r = await raw(t);
      r.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: `n${i}`, locale: 'en', client: 't' } });
      expect((await r.next()).t).toBe('challenge');
    }
    const sixth = await raw(t);
    sixth.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: 'n6', locale: 'en', client: 't' } });
    expect(await sixth.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
  });
});

describe('authentication failure limit (10/min per IP, failures only)', () => {
  it('successes never count', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    for (let i = 0; i < 15; i++) {
      const c = await connectTestClient(t.server, { seed });
      expect(c.welcome, `login ${i}`).toBeDefined();
      c.close();
    }
  });

  it('PROTOCOL_UNSUPPORTED is not a credential failure', async () => {
    const t = await server();
    for (let i = 0; i < 12; i++) expect((await connectTestClient(t.server, { protocol: 99 })).error?.code).toBe('PROTOCOL_UNSUPPORTED');
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });

  it('after 10 failures even valid credentials get RATE_LIMITED until the minute passes', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    for (let i = 0; i < 10; i++) await failOnce(t);
    expect((await connectTestClient(t.server)).error?.code).toBe('RATE_LIMITED');
    clock.t += 60_001;
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });

  it('counts wrong invites, so invite codes cannot be brute-forced', async () => {
    const t = await server({ joinMode: 'invite' });
    for (let i = 0; i < 10; i++) {
      expect((await connectTestClient(t.server, { inviteCode: `AAAAAAAAA${'234567ABCD'[i]}` })).error?.code).toBe('INVITE_INVALID');
    }
    const real = t.server.createInvite().code;
    expect((await connectTestClient(t.server, { inviteCode: real })).error?.code).toBe('RATE_LIMITED');
  });
});

describe('heartbeat (spec §5.1)', () => {
  it('drops a peer that stops answering pings', async () => {
    const t = await server({ limits: { pingIntervalMs: 50, pongTimeoutMs: 300 } });
    const silent = await connectRaw(t.server, { autoPong: false });
    sockets.push(silent);
    const started = Date.now();
    const { code } = await silent.closed;
    expect(code).toBe(1006); // terminated, no close frame
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps a responsive peer connected', async () => {
    const t = await server({ limits: { pingIntervalMs: 100, pongTimeoutMs: 1_000 } });
    const c = await connectTestClient(t.server);
    await new Promise((r) => setTimeout(r, 1_300)); // several ping/pong rounds, longer than pongTimeoutMs

    expect(await c.request('ping')).toMatchObject({ ok: true });
    c.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- apps/server/test/integration/limits.test.ts`
Expected: PASS — `Tests  10 passed (10)`. If one fails, fix the gateway/handshake accounting, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/integration/limits.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover pre-auth and auth rate limits end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Lifecycle suite (session replacement, shutdown, restarts)

**Files:**
- Test: `apps/server/test/integration/lifecycle.test.ts`

Acceptance coverage for: `SESSION_REPLACED` (spec §3.3), graceful `close()` sending `SERVER_SHUTDOWN` to authenticated **and** unauthenticated sockets and then refusing HTTP, persistence across restarts (same `serverKeyId`, first-run `name`/`joinMode` kept, members and invites preserved), refusal of a newer database at startup, `EADDRINUSE` surfacing with the DB released, and `createInvite` addresses (configured, deduplicated, fallback `127.0.0.1:<port>`, invalid ones rejected at startup).

- [ ] **Step 1: Write the suite**

`apps/server/test/integration/lifecycle.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolError, parseJoinInput } from '@ghostlink/shared';
import { DatabaseTooNewError } from '../../src/db/database.js';
import { silentLogger, startServer } from '../../src/index.js';
import { withDb } from '../helpers/db.js';
import { connectRaw, connectTestClient, startTestServer, type TestServer } from '../helpers/testClient.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-life-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('single session per identity', () => {
  it('a new login closes the previous one with SESSION_REPLACED', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    const first = await connectTestClient(t.server, { seed });
    const second = await connectTestClient(t.server, { seed });
    expect(await first.waitEvent('error')).toEqual({ t: 'error', d: { code: 'SESSION_REPLACED' } });
    expect(await first.raw.closed).toEqual({ code: 4000, reason: 'SESSION_REPLACED' });
    expect(await second.request('ping')).toMatchObject({ ok: true });
    second.close();
  });

  it('other identities are unaffected', async () => {
    const t = await server();
    const a = await connectTestClient(t.server);
    const b = await connectTestClient(t.server);
    expect(await a.request('ping')).toMatchObject({ ok: true });
    a.close();
    b.close();
  });
});

describe('graceful shutdown', () => {
  it('sends SERVER_SHUTDOWN to authenticated and unauthenticated sockets, then stops listening', async () => {
    const t = await startTestServer({ joinMode: 'open' });
    const authed = await connectTestClient(t.server);
    const pending = await connectRaw(t.server);
    await t.server.close();
    expect(await authed.waitEvent('error')).toEqual({ t: 'error', d: { code: 'SERVER_SHUTDOWN' } });
    expect(await pending.next()).toEqual({ t: 'error', d: { code: 'SERVER_SHUTDOWN' } });
    expect((await pending.closed).reason).toBe('SERVER_SHUTDOWN');
    await expect(new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: t.server.port, path: '/health', rejectUnauthorized: false }, resolve).on('error', reject).end();
    })).rejects.toThrow();
    await t.server.close(); // idempotent
    rmSync(t.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe('persistence across restarts', () => {
  it('keeps serverKeyId, name, members and invites; first-run options are ignored later', async () => {
    const dataDir = tempDir();
    const first = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Primeiro', joinMode: 'invite' });
    const invite = first.createInvite({ maxUses: 2 });
    const seed = new Uint8Array(32).fill(2);
    const member = await connectTestClient(first, { seed, inviteCode: invite.code });
    expect(member.welcome).toBeDefined();
    const keyId = first.serverKeyId;
    await first.close();

    const second = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Outro', joinMode: 'open' });
    try {
      expect(second.serverKeyId).toBe(keyId);
      const back = await connectTestClient(second, { seed });
      expect(back.welcome?.server).toMatchObject({ name: 'Primeiro', joinMode: 'invite' });
      back.close();
      const other = await connectTestClient(second, { inviteCode: invite.code });
      expect(other.welcome).toBeDefined(); // second use of the same invite
      other.close();
    } finally {
      await second.close();
    }
  });

  it('refuses to start on a database from a newer version', async () => {
    const dataDir = tempDir();
    const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await s.close();
    withDb(dataDir, (db) => db.exec('PRAGMA user_version = 999'));
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger })).rejects.toBeInstanceOf(DatabaseTooNewError);
  });

  it('reports EADDRINUSE and releases the database so a retry works', async () => {
    const t = await server();
    const dataDir = tempDir();
    await expect(startServer({ dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    const retry = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await retry.close();
  });
});

describe('GhostServer.createInvite', () => {
  it('uses the configured public addresses and the server name', async () => {
    const t = await server({ name: 'Casa', publicAddresses: ['203.0.113.9:7700', 'casa.example:7710', '203.0.113.9'] });
    const info = t.server.createInvite({ maxUses: 3, expiresInHours: 24 });
    expect(parseJoinInput(info.link)).toEqual({
      kind: 'invite',
      invite: { addresses: ['203.0.113.9:7700', 'casa.example:7710'], serverKeyId: t.server.serverKeyId, inviteCode: info.code, name: 'Casa' },
    });
    expect(parseJoinInput(info.webLink)).toEqual(parseJoinInput(info.pasteCode));
  });

  it('falls back to 127.0.0.1:<port> when no public address is configured', async () => {
    const t = await server();
    const parsed = parseJoinInput(t.server.createInvite().pasteCode);
    expect(parsed.kind === 'invite' && parsed.invite.addresses).toEqual([`127.0.0.1:${t.server.port}`]);
  });

  it('rejects invalid public addresses at startup', async () => {
    await expect(startServer({ dataDir: tempDir(), port: 0, host: '127.0.0.1', logger: silentLogger, publicAddresses: ['bad host'] }))
      .rejects.toBeInstanceOf(ProtocolError);
  });

  it('validates invite options', async () => {
    const t = await server();
    expect(() => t.server.createInvite({ maxUses: 0 })).toThrow(ProtocolError);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- apps/server/test/integration/lifecycle.test.ts`
Expected: PASS — `Tests  10 passed (10)`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/integration/lifecycle.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover session replacement, shutdown and restarts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: `ghostlink-server` CLI

**Files:**
- Create: `apps/server/src/cli.ts`, `apps/server/src/bin.ts`
- Test: `apps/server/test/integration/cli.test.ts`

Contract §4 / spec §10 (M1 subset): `start | invite | setup-code | status | version`, `node:util.parseArgs` (strict), English output, exit codes `0` ok, `1` error/usage, `2` port in use (spec §8.5). `--data` defaults to `$GHOSTLINK_DATA`. `start` flags: `--port` (default 7700, `0` = random), `--host` (default `0.0.0.0`), `--name`, `--public-address` (repeatable); it prints the version, data dir, `Listening on <host>:<port>`, the fingerprint in the app's format and — while no owner exists — the setup code, then runs until SIGINT/SIGTERM. `invite`, `setup-code` and `status` work **while the server is running** (second SQLite connection in WAL mode); they refuse a directory without server data, and `invite` refuses when no public address is configured (an invite pointing at `127.0.0.1` is useless on a VPS). `status` never writes. `runCli(argv, io, env)` is exported for in-process tests; `bin.ts` is the executable entry that esbuild bundles (Task 24). `reset-owner`, `--upnp` and `--node-ip` belong to later milestones.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/cli.test.ts` — including the end-to-end check that a code printed by `ghostlink-server invite` is accepted by the running server:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFingerprint, parseJoinInput } from '@ghostlink/shared';
import { runCli, type CliIo } from '../../src/cli.js';
import { SERVER_VERSION } from '../../src/index.js';
import { withDb } from '../helpers/db.js';
import { connectTestClient, startTestServer, type TestServer } from '../helpers/testClient.js';

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}

describe('ghostlink-server CLI', () => {
  it('version prints the package version', async () => {
    const io = capture();
    expect(await runCli(['version'], io, {})).toBe(0);
    expect(io.stdout).toEqual([SERVER_VERSION]);
  });

  it('--help exits 0; no command, unknown command or unknown flag exit 1', async () => {
    const help = capture();
    expect(await runCli(['--help'], help, {})).toBe(0);
    expect(help.stdout.join('\n')).toMatch(/Usage: ghostlink-server/);
    expect(await runCli([], capture(), {})).toBe(1);
    const unknown = capture();
    expect(await runCli(['frobnicate'], unknown, {})).toBe(1);
    expect(unknown.stderr[0]).toMatch(/Unknown command/);
    const flag = capture();
    expect(await runCli(['status', '--nope'], flag, {})).toBe(1);
    expect(flag.stderr.join('\n')).toMatch(/--help/);
  });

  it('requires a data directory', async () => {
    const io = capture();
    expect(await runCli(['status'], io, {})).toBe(1);
    expect(io.stderr[0]).toMatch(/--data/);
  });

  it('refuses to operate on a directory without server data', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ghostlink-cli-empty-'));
    dirs.push(empty);
    for (const command of ['status', 'invite', 'setup-code']) {
      const io = capture();
      expect(await runCli([command, '--data', empty], io, {}), command).toBe(1);
      expect(io.stderr[0]).toMatch(/No GhostLink server data/);
    }
  });

  it('invite works against a running server and the code is accepted by it', async () => {
    const t = await server({ publicAddresses: ['198.51.100.7:7700'], name: 'VPS' });
    const io = capture();
    expect(await runCli(['invite', '--data', t.dataDir, '--max-uses', '1', '--expires', '2d'], io, {})).toBe(0);
    const code = /^Invite code: ([A-Z2-7]{10})$/.exec(io.stdout[0]!)![1]!;
    const web = io.stdout.find((l) => l.startsWith('Web link'))!.split(': ')[1]!;
    expect(parseJoinInput(web)).toEqual({
      kind: 'invite',
      invite: { addresses: ['198.51.100.7:7700'], serverKeyId: t.server.serverKeyId, inviteCode: code, name: 'VPS' },
    });
    const row = withDb(t.dataDir, (db) => db.get<{ max_uses: number; expires_at: number }>('SELECT max_uses, expires_at FROM invites WHERE code = ?', code))!;
    expect(row.max_uses).toBe(1);
    expect(row.expires_at - Date.now()).toBeGreaterThan(47 * 3_600_000);
    const client = await connectTestClient(t.server, { inviteCode: code });
    expect(client.welcome).toBeDefined();
    client.close();
  });

  it('invite refuses when no public address is configured', async () => {
    const t = await server();
    const io = capture();
    expect(await runCli(['invite', '--data', t.dataDir], io, {})).toBe(1);
    expect(io.stderr[0]).toMatch(/--public-address/);
  });

  it.each([
    [['--max-uses', '0']],
    [['--max-uses', 'abc']],
    [['--expires', '10m']],
  ])('invite validates %j', async (flags) => {
    const t = await server({ publicAddresses: ['198.51.100.7:7700'] });
    expect(await runCli(['invite', '--data', t.dataDir, ...flags], capture(), {})).toBe(1);
  });

  it('setup-code prints the pending code, then reports the owner', async () => {
    const t = await server();
    const io = capture();
    expect(await runCli(['setup-code', '--data', t.dataDir], io, {})).toBe(0);
    expect(io.stdout).toEqual([t.server.setupCode()]);
    (await connectTestClient(t.server, { setupCode: io.stdout[0]! })).close();
    const after = capture();
    expect(await runCli(['setup-code'], after, { GHOSTLINK_DATA: t.dataDir })).toBe(0);
    expect(after.stdout[0]).toMatch(/already has an owner/);
  });

  it('status prints the fingerprint in the same format as the app', async () => {
    const t = await server({ name: 'Status', publicAddresses: ['198.51.100.7:7700'] });
    const io = capture();
    expect(await runCli(['status', '--data', t.dataDir], io, {})).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain(`Fingerprint: ${formatFingerprint(t.server.serverKeyId)}`);
    expect(text).toContain('Name: Status');
    expect(text).toContain('Join mode: invite');
    expect(text).toContain('Members: 0 / 100');
    expect(text).toContain('Public addresses: 198.51.100.7:7700');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/integration/cli.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/cli.js'`.

- [ ] **Step 3: Implement `cli.ts`**

```ts
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ProtocolError, formatFingerprint } from '@ghostlink/shared';
import { ensureSetupCode } from './auth/setupCode.js';
import { dataPaths } from './config/paths.js';
import { Db, DatabaseTooNewError } from './db/database.js';
import { getMeta } from './db/serverMeta.js';
import { consoleLogger, startServer } from './index.js';
import { buildInviteInfo, createInvite } from './invites/invites.js';
import { readCertificate } from './tls/certificate.js';
import { SERVER_VERSION } from './version.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PORT_IN_USE = 2; // spec §8.5

const USAGE = `Usage: ghostlink-server <command> [options]

Commands:
  start        Run the server
  invite       Create an invite (works while the server is running)
  setup-code   Print the pending owner setup code
  status       Print version, fingerprint and membership summary
  version      Print the server version

Options:
  --data <dir>               Data directory (default: $GHOSTLINK_DATA)
  --port <n>                 start: TCP port (default 7700, 0 = random)
  --host <address>           start: bind address (default 0.0.0.0)
  --name <text>              start: server name (first run only)
  --public-address <h:p>     start: address to put in invites (repeatable)
  --max-uses <n>             invite: maximum number of uses
  --expires <n>h | <n>d      invite: expiry, e.g. 24h or 7d
  -h, --help                 Show this help`;

class UsageError extends Error {}

const OPTIONS = {
  data: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  name: { type: 'string' },
  'public-address': { type: 'string', multiple: true },
  'max-uses': { type: 'string' },
  expires: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function dataDirOf(values: Values, env: NodeJS.ProcessEnv): string {
  const dir = values.data ?? env.GHOSTLINK_DATA;
  if (!dir) throw new UsageError('Missing --data <dir> (or set GHOSTLINK_DATA).');
  return resolve(dir);
}

function integer(text: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a whole number.`);
  const n = Number(text);
  if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}.`);
  return n;
}

function hoursOf(text: string): number {
  const m = /^(\d+)([hd])$/.exec(text);
  if (!m) throw new UsageError('--expires must look like 24h or 7d.');
  return Number(m[1]) * (m[2] === 'd' ? 24 : 1);
}

/** Opens an initialized data dir; returns null (after printing why) when there is nothing there. */
function openExisting(dataDir: string, io: CliIo): Db | null {
  if (readCertificate(dataDir) === null) {
    io.err(`No GhostLink server data in ${dataDir}. Run "ghostlink-server start --data ${dataDir}" first.`);
    return null;
  }
  return new Db(dataPaths(dataDir).db);
}

async function cmdStart(values: Values, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const dataDir = dataDirOf(values, env);
  const port = values.port === undefined ? 7700 : integer(values.port, '--port', 0, 65535);
  const host = values.host ?? '0.0.0.0';
  let server;
  try {
    server = await startServer({
      dataDir,
      port,
      host,
      name: values.name,
      publicAddresses: values['public-address'],
      logger: consoleLogger,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port} is already in use by another program. Choose another one with --port.`);
      return EXIT_PORT_IN_USE;
    }
    throw e;
  }
  io.out(`GhostLink server ${server.version}`);
  io.out(`Data directory: ${dataDir}`);
  io.out(`Listening on ${host}:${server.port}`);
  io.out(`Fingerprint: ${formatFingerprint(server.serverKeyId)}`);
  const setupCode = server.setupCode();
  if (setupCode !== null) io.out(`Setup code (use it once to become the owner): ${setupCode}`);
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  io.out('Shutting down…');
  await server.close();
  return EXIT_OK;
}

function cmdInvite(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const maxUses = values['max-uses'] === undefined ? undefined : integer(values['max-uses'], '--max-uses', 1, 10_000);
  const expiresInHours = values.expires === undefined ? undefined : hoursOf(values.expires);
  const certificate = readCertificate(dataDir);
  const db = openExisting(dataDir, io);
  if (!db || !certificate) return EXIT_ERROR;
  try {
    db.migrate();
    const meta = getMeta(db);
    if (meta.publicAddresses.length === 0) {
      io.err('No public address configured. Start the server with --public-address <host:port> first.');
      return EXIT_ERROR;
    }
    const { code } = createInvite(db, { maxUses, expiresInHours, now: Date.now() });
    const info = buildInviteInfo(code, { addresses: meta.publicAddresses, serverKeyId: certificate.serverKeyId, name: meta.name });
    io.out(`Invite code: ${info.code}`);
    io.out(`Uses: ${maxUses ?? 'unlimited'}  Expires: ${expiresInHours === undefined ? 'never' : `in ${expiresInHours} h`}`);
    io.out(`Web link (share this): ${info.webLink}`);
    io.out(`App link: ${info.link}`);
    io.out(`Paste code: ${info.pasteCode}`);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

function cmdSetupCode(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const db = openExisting(dataDir, io);
  if (!db) return EXIT_ERROR;
  try {
    db.migrate();
    const code = ensureSetupCode(db, dataDir);
    io.out(code === null ? 'This server already has an owner; there is no pending setup code.' : code);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

function cmdStatus(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const certificate = readCertificate(dataDir);
  const db = openExisting(dataDir, io);
  if (!db || !certificate) return EXIT_ERROR;
  try {
    if (db.userVersion === 0) {
      io.err(`The database in ${dataDir} is not initialized. Start the server once first.`);
      return EXIT_ERROR;
    }
    const meta = getMeta(db);
    const members = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL')?.n ?? 0);
    io.out(`GhostLink server ${SERVER_VERSION}`);
    io.out(`Data directory: ${dataDir}`);
    io.out(`Name: ${meta.name}`);
    io.out(`Fingerprint: ${formatFingerprint(certificate.serverKeyId)}`);
    io.out(`Server key ID: ${certificate.serverKeyId}`);
    io.out(`Join mode: ${meta.joinMode}`);
    io.out(`Members: ${members} / ${meta.maxMembers}`);
    io.out(`Owner: ${meta.ownerUserId === null ? 'none yet (setup code pending)' : meta.ownerUserId}`);
    io.out(`Public addresses: ${meta.publicAddresses.length > 0 ? meta.publicAddresses.join(', ') : '(none configured)'}`);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

/** Entry point of the ghostlink-server command. Output is English (contract §4). */
export async function runCli(argv: string[], io: CliIo = defaultIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...extra] = positionals;
    if (values.help || command === undefined) {
      io.out(USAGE);
      return values.help ? EXIT_OK : EXIT_ERROR;
    }
    if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra[0]}`);
    switch (command) {
      case 'start':
        return await cmdStart(values, env, io);
      case 'invite':
        return cmdInvite(values, env, io);
      case 'setup-code':
        return cmdSetupCode(values, env, io);
      case 'status':
        return cmdStatus(values, env, io);
      case 'version':
        io.out(SERVER_VERSION);
        return EXIT_OK;
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err((e as Error).message);
      io.err('Run "ghostlink-server --help" for usage.');
      return EXIT_ERROR;
    }
    if (e instanceof DatabaseTooNewError || e instanceof ProtocolError) {
      io.err(e.message);
      return EXIT_ERROR;
    }
    io.err(`Unexpected error: ${(e as Error).stack ?? String(e)}`);
    return EXIT_ERROR;
  }
}
```

- [ ] **Step 4: Create `bin.ts`**

```ts
// Executable entry: esbuild bundles this file into dist/cli.js (the "ghostlink-server" bin).
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- apps/server/test/integration/cli.test.ts`
Expected: PASS — `Tests  11 passed (11)`.

- [ ] **Step 6: Smoke-test the dev entry**

Run: `npm run dev -w @ghostlink/server -- version`
Expected: last line `0.1.0`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/cli.ts apps/server/src/bin.ts apps/server/test/integration/cli.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add ghostlink-server CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Bundle the CLI with esbuild

**Files:**
- Create: `apps/server/scripts/build.mjs`
- Test: `apps/server/test/integration/bundle.test.ts`

Verified with esbuild 0.28.2: bundling to ESM needs a `createRequire` banner, otherwise the CommonJS dependencies (ws, reflect-metadata, tsyringe) crash at startup with `Dynamic require of "events" is not supported`. `bufferutil`/`utf-8-validate` stay external (ws probes them inside `try/catch`). `reflect-metadata` still runs before `@peculiar/x509` in the bundle. The migrations are copied to `dist/migrations/` because `loadMigrations()` resolves them next to the running file. The bundle test runs the real build, then executes `dist/cli.js` with `version` and with `start` (checking `/health` on the printed port).

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/bundle.test.ts`:

```ts
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../src/index.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(serverRoot, 'dist', 'cli.js');
const nodeFlags = ['--disable-warning=ExperimentalWarning'];
let dataDir: string;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: serverRoot, stdio: 'pipe' });
  dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-bundle-'));
}, 60_000);
afterAll(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('bundled CLI (dist/cli.js)', () => {
  it('ships the migrations next to the bundle', () => {
    expect(existsSync(cli)).toBe(true);
    expect(existsSync(join(serverRoot, 'dist', 'migrations', '001_init.sql'))).toBe(true);
  });

  it('runs "version" without node_modules-only tricks', () => {
    const out = execFileSync(process.execPath, [...nodeFlags, cli, 'version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(SERVER_VERSION);
  });

  it('"start" serves /health on the printed port', async () => {
    const child = spawn(process.execPath, [...nodeFlags, cli, 'start', '--data', dataDir, '--port', '0', '--host', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`no "Listening on" line; got: ${buffer}`)), 15_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const m = /Listening on 127\.0\.0\.1:(\d+)/.exec(buffer);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.once('exit', (code) => reject(new Error(`exited early with ${code}: ${buffer}`)));
      });
      const body = await new Promise<string>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () => resolve(b));
        }).on('error', reject).end();
      });
      expect(JSON.parse(body)).toMatchObject({ ok: true, version: SERVER_VERSION });
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apps/server/test/integration/bundle.test.ts`
Expected: FAIL — `Error: Command failed: … scripts/build.mjs` with `Cannot find module '…/apps/server/scripts/build.mjs'`.

- [ ] **Step 3: Implement `scripts/build.mjs`**

```js
// Bundles the VPS CLI into dist/cli.js (single file + dist/migrations/*.sql).
import { build } from 'esbuild';
import { chmodSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // ws probes these optional native add-ons inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (ws, reflect-metadata, tsyringe…) call require(); ESM output needs a real one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ghostlinkCreateRequire } from 'node:module';\nconst require = __ghostlinkCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// database.ts reads migrations from new URL('./migrations/', import.meta.url) = dist/migrations/ in the bundle.
cpSync(fileURLToPath(new URL('../src/db/migrations/', import.meta.url)), fileURLToPath(new URL('../dist/migrations/', import.meta.url)), {
  recursive: true,
});

if (process.platform !== 'win32') chmodSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 0o755);

console.log('Built apps/server/dist/cli.js');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- apps/server/test/integration/bundle.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Run the build script and the bundled help**

Run:
```bash
npm run build
node --disable-warning=ExperimentalWarning apps/server/dist/cli.js --help
git status --short
```
Expected: `Built apps/server/dist/cli.js`; the usage text starting with `Usage: ghostlink-server <command> [options]`; `git status` does **not** list `apps/server/dist/` (ignored).

- [ ] **Step 6: Commit**

```bash
git add apps/server/scripts/build.mjs apps/server/test/integration/bundle.test.ts
git commit -m "$(cat <<'EOF'
build(server): bundle the CLI with esbuild

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: Final verification

**Files:** none (fix-ups only if a gate fails).

- [ ] **Step 1: Run every gate from a clean state**

Run:
```bash
npm run typecheck
npm run lint
npm test
npm run build
```
Expected: typecheck and lint exit 0 with no diagnostics; Vitest prints `Test Files  31 passed (31)` and `Tests  433 passed (433)` on Linux/macOS (on Windows: `Tests  429 passed | 4 skipped (433)` — the POSIX file-mode tests); the build prints `Built apps/server/dist/cli.js`.

- [ ] **Step 2: Run the suite twice more to catch flakiness**

Run: `npm test && npm test`
Expected: identical results. Timing-sensitive tests use generous margins or polling; a failure here is a real bug.

- [ ] **Step 3: Check the tree**

Run: `git status --short`
Expected: empty output (everything committed; `dist/`, `node_modules/` and data directories ignored).

- [ ] **Step 4: Commit only if Step 1–3 required fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: address final verification findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Where |
|---|---|
| §2.1 boundaries: shared has no Node/DOM APIs; server sends only error codes | Task 1 (tsconfig/ESLint rules), Tasks 2–7, 19 |
| §3.2 certificate profile, `serverKeyId` = SHA-256(SPKI) | Task 10 |
| §3.2 `userId` = hex(SHA-256(pk))[0:32]; lookup by full public key | Tasks 13, 18 |
| §3.3 hello → challenge → proof, nonce 32 B single use 30 s, signature over `ghostlink-auth-v1\n<id>\n<nonce>` bound to serverKeyId | Tasks 5, 14, 19 (tests: handshake suite) |
| §3.3 deadlines 5 s / 10 s | Tasks 17, 19 |
| §3.3 all handshake error codes (`PROTOCOL_UNSUPPORTED` with min/max, `BAD_PASSWORD`, `INVITE_REQUIRED`, `INVITE_INVALID`, `BAD_SIGNATURE`, `CHALLENGE_EXPIRED`, `SERVER_FULL`, `BANNED`, `REJOIN_BLOCKED`, `NICK_TAKEN`, `RATE_LIMITED`, `BAD_SETUP_CODE`) | Tasks 18–21 |
| §3.3 join modes open/password (first access only)/invite; members skip checks | Tasks 18, 20 |
| §3.3 setup code: 128 bits, 4 groups, file 0600, hash in DB, bypasses invite/password/max_members, consumed atomically with `owner_user_id`, file deleted | Tasks 12, 18, 20 |
| §3.3 single session: `SESSION_REPLACED` | Tasks 16, 19, 22 |
| §3.5 invite codes, atomic consumption in one synchronous tx with `max_members` and insert/reactivation; `INVITE_INVALID` on `changes === 0`; addresses from the server | Tasks 11 (`tx` refuses async), 15, 18, 19, 20 |
| §3.5 link / paste code / web link formats | Tasks 7, 15 |
| §3.6 frozen labels | Task 2 |
| §4 routes `/health`, `HEAD|GET /` with CORS `*`, `/ws`, 404; `headersTimeout` 10 s, `requestTimeout` 30 s | Task 19 |
| §5.1 envelope, strict server schemas / lenient client schemas, serial processing, re-check after await, 256 KiB frames, ping 15 s / pong 30 s, protocol range, `features` | Tasks 4, 17, 19 |
| §5.2 `ping` | Task 16 |
| §5.3 `welcome` (M1 fields), `error` before close with `SESSION_REPLACED`/`SERVER_SHUTDOWN` | Tasks 19, 22 |
| §7 pragmas, migrations in transactions, `VACUUM INTO` backup (3 newest), refuse newer `user_version`, BLOBs as Uint8Array, 0600 secrets | Tasks 8, 10, 11, 12 |
| §7 schema `server_meta`, `users`, `bans`, `invites` | Task 11 |
| §7 nickname rules and `NICK_TAKEN` | Tasks 6, 18 |
| §7 IPs logged only on auth failures | Task 19 (`handshake.ts`) |
| §7/§3.3 removal: `removed_at` / `rejoin_blocked_until` checks | Tasks 18, 20 |
| §8.5 CLI exits 2 on `EADDRINUSE` | Task 23 |
| §10 CLI `start`, `invite`, `setup-code`, `status`, `version` (English) | Task 23 |
| §12 deep-link validation limits (≤ 8 addresses, ≤ 2 KB, ports 1–65535) | Task 7 |
| §13 pre-auth caps (256 total, 20/IP), scrypt ≤ 2 concurrent after the rate limit, 10 failures/min/IP (failures only), 5 pending challenges/IP, IPv6 /64, 5 new identities/IP/hour, 30 requests/s/session | Tasks 9, 14, 18, 19, 21 |
| §14 server integration items for M1 (handshake and all errors, pre-auth deadlines, join modes, invite race, `max_members`, setup code, session replaced, rate limits, backup before migrate and downgrade refusal) | Tasks 11, 19–22 |
| §15 `.gitignore` contents | Task 1 |
| §17 step 1 (shared + server parts), CLI `start`/`invite` | All tasks |

Out of scope here (plans 1b/1c or later milestones): desktop/Electron, pinning in the renderer, CI workflows, packaging, `reset-owner`, UPnP, LiveKit, chat features.

---

## Contract notes

The contract was followed exactly for every name, signature, version and path it defines. Below are the problems found while verifying it against the real packages, and every addition this plan makes.

1. **`vitest.config.ts` cannot list `apps/desktop` yet.** Vitest 5.0.2 aborts with `Projects definition references a non-existing file or a directory` for a missing project directory (verified). Plan 1a lists `['packages/shared', 'apps/server']`. **Plan 1b must append `'apps/desktop'`** in the same commit that creates that directory.
2. **TypeScript 6 defaults `types` to `[]`** (verified: `process`/`node:*` are unknown without it). Every tsconfig must set `types` explicitly: `["node"]` for the server (and for desktop main/preload in 1b); shared uses `lib: ["ES2023", "DOM"]` with `types: []`. Recommended for 1b: the renderer tsconfig uses DOM with `types: []` too.
3. **Additive exports in `@ghostlink/shared`:** `fromUtf8` (strict UTF-8 decode, `encoding.ts`), `formatHostPort` and `normalizeInviteCode` (`invite.ts`), `sanitizeLabel` (`text.ts`). `parseJoinInput` returns addresses canonicalized as `host:port` (lowercased host, default port filled, IPv6 bracketed); bare unbracketed IPv6 is rejected as ambiguous.
4. **`normalizeNickname` is stricter than the contract's wording** (a superset, same signature): it strips all of `\p{Cf}` and `\p{Cc}`, lone surrogates and blank-looking letters (Hangul fillers, Braille blank, U+034F, U+17B4/5); runs NFKC a second time after stripping (closes a look-alike hole); requires a letter/number/punctuation/symbol; caps graphemes at 10 code points; rejects raw input over 256 UTF-16 units. Stripping U+200D (required by the contract) splits emoji ZWJ sequences — accepted and tested.
5. **Security: small-order Ed25519 keys.** Node/OpenSSL `crypto.verify` accepts the all-zero signature for the all-zero public key for some messages (verified with the exact auth message used in `identity.test.ts`). The server rejects the libsodium small-order blocklist (`isWeakPublicKey`, additive export of `auth/identity.ts`) both at `hello` and in `verifyAuthSignature`. Recommend adding one sentence to spec §3.2.
6. **`StartServerOptions.limits?: Partial<ServerLimits>`** (additive, tests only) lets tests shrink deadlines and caps; `ServerLimits` is exported as a type. `index.ts` also exports `consoleLogger` and `silentLogger`.
7. **Error codes where the contract has none:** a missed `hello` deadline closes with `BAD_REQUEST`; a missed `auth.proof` deadline with `CHALLENGE_EXPIRED`. Pre-auth cap rejections are delivered **after** the WebSocket upgrade as `error { RATE_LIMITED }` (not HTTP 429), so clients have one error channel. Application closes use WebSocket close code **4000** with the `ErrorCode` as reason; oversize frames close with 1009; heartbeat timeouts terminate (1006). Recommend 1b treat `BAD_REQUEST`/`CHALLENGE_EXPIRED` during the handshake as retryable.
8. **Setup code format** (contract says only "string"): 32 lowercase hex digits in 4 groups joined by `-`; input is normalized (case, spaces and dashes ignored). The Hospedar flow in 1b reads `data/setup-code.txt` and trims it.
9. **Migrations are read at runtime** from `new URL('./migrations/', import.meta.url)` next to the file that contains `database.ts`. esbuild copies them to `dist/migrations/` (Task 24). **Plan 1b's electron-vite build of `serverEntry` must copy `apps/server/src/db/migrations/*.sql` to the output directory of that bundle** (e.g. `out/main/migrations/`), or `startServer` fails with `ENOENT`. `Db` gains additive members: `migrate(migrations?)`, `userVersion`, `inTransaction`, `exec`, plus `loadMigrations()` and `DatabaseTooNewError`.
10. **esbuild ESM bundles need a `createRequire` banner** (verified crash without it). Any other bundler in 1b/1c that emits ESM containing ws/x509 must do the same or emit CJS.
11. **CLI entry split:** `src/cli.ts` exports `runCli(argv, io, env)`; `src/bin.ts` (additive) is what esbuild bundles to `dist/cli.js`. On Node 24.14 the bundled bin prints the SQLite ExperimentalWarning once (static import at link time); Node ≥ 24.15 does not. The contract keeps `engines.node >=24.14`; the earlier verification notes recommended `>=24.15` — worth revisiting when CI images move.
12. **Test helper additions:** `testClient.ts` also exports `connectRaw`, `RawClient`, `makeIdentity`, `TestIdentity`, `TestServer`, `ConnectTestClientOptions` (adds `locale`); `TestClient` also exposes `identity` and `raw`. There is no package export for test helpers; plan 1b imports them by relative path (`../../server/test/helpers/testClient.js`) or adds a `"./test-helpers"` export in its own plan. `startTestServer` binds `127.0.0.1` and keeps the production default join mode `invite`.
13. **Desktop pinning technique (for 1b):** ws 8.22.0 honours `createConnection`; set `path: undefined` and `servername` only for DNS names, and cast the function (`as unknown as typeof net.createConnection`) because of `@types/ws`. `testClient.ts` is a working reference.
14. **Behavioural details the desktop should know:** existing members keep their stored nickname (the `hello` nickname is only used when joining; display `welcome.self.nickname`); passwords are NFKC-normalized server-side (send them raw); `locale` must match `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$` (Electron's `app.getLocale()` format such as `pt-BR` is fine; `pt_BR` is not); client schemas map unknown error codes to `INTERNAL`.
15. **CLI `invite` requires configured public addresses** (`--public-address` on `start`); `GhostServer.createInvite` falls back to `127.0.0.1:<port>` (useful for the Hospedar self-join and tests). The `start` flags `--node-ip`/`--upnp` (spec §10) are deferred to M5/M7.
16. **Storage formats later milestones must keep:** `bans.ip` is compared against `ipKey(remoteAddress)` (IPv4 as-is, IPv6 as its `/64` key such as `2001:db8:0:0::/64`), so M3's `member.ban { banIp }` must store `ipKey(...)`, not the raw address; `users.last_ip` stores the raw address. `invites.created_by` is `NULL` for invites created by the CLI or `GhostServer.createInvite` without `createdBy`.
