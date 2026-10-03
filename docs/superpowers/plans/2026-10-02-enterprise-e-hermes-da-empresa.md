# Enterprise Servers and the Company's Own Hermes — Implementation Plan (v0.6.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> The owner wants speed: after Task 0 and the contract (Task 1), **four tracks run in parallel** in the same worktree. Each track works test-first and ends with `npm run lint`, `npm run typecheck` and **its own** test files green; CI is the gate (no repeated full local runs). Commit only your own files (`git add <paths>`, never `-A`); another track commits in the same worktree, so retry once if `index.lock` is busy.

**Goal:** a GhostLink server becomes **Enterprise** with a signed, time-limited license; Enterprise servers lose the Ghost DJ and gain **the company's own Hermes**, a bot whose AI keys, models, skills, access and memory the owner manages from the bot's settings, applied by the Hermes Agent GhostLink plugin.

**Architecture:** a new `enterprise` server module checks the license (Ed25519, a key of its own) at paste, at start and hourly, and publishes the edition; the Ghost DJ hides itself while the server is Enterprise. A new `companyHermes` module marks one bot as the company Hermes, stores its settings and keys in the server database, and sends `hermes.config` only to that bot's session; the plugin applies it to `$HERMES_HOME` (keys only in the process environment) and answers with `hermes.report`, which the owner's app shows live through `hermes.state`.

**Tech Stack:** TypeScript (Node 24, `node:sqlite`, zod 4), React/Electron renderer (zustand), Python 3.11+ plugin (aiohttp, cryptography, ruamel.yaml), vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-enterprise-e-hermes-da-empresa-design.md` (pt-BR). Sections 1–3 are code (this plan's Tasks 1–I); section 4 is the runbook (Task R), done by the main session **with the owner** after the release.

**Branch:** `v0.6.0-dev`, worktree `.claude/worktrees/v060`. Run every command from the worktree root.

---

## Rules for every task (owner, 2026-10-02: the repository is public)

1. **No key, token or secret in any committed file, test fixture or doc.** Tests build obviously fake values at run time (`'sk-test-ok-' + randomBytes(12).toString('hex')`), make Ed25519 license keys per test run (`testLicenseKey()`), and never print a secret.
2. **The license private key never enters the repository.** `scripts/gen-license-key.mjs` writes it only outside every git work tree, never overwrites, never prints it.
3. **The company's AI keys** live in the GhostLink server's database (never returned to an app, never logged) and, on the Hermes side, **only in the gateway process's environment**: the plugin never writes them to disk. GhostLink sends them again on every connection.
4. Never log request payloads, `hermes.config`, licenses or key values; error messages never echo input. (The dispatcher already logs no payloads and turns zod errors into `invalid payload`.)

## What Hermes Agent's public source says (checked 2026-10-02, `NousResearch/hermes-agent@46904a3`)

| Topic | Fact | Source |
|---|---|---|
| Skill on/off | `config.yaml` → `skills.disabled: [names]` (global) and `skills.platform_disabled.<platform>`; `hermes-agent` is essential and can never be disabled. Read through an mtime-cached loader, so no restart; the gateway's agent cache is not busted by it, so a change counts **from the next conversation**. | [`hermes_cli/skills_config.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/hermes_cli/skills_config.py), [`agent/skill_utils.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/agent/skill_utils.py) (`get_disabled_skill_names`, `ESSENTIAL_SKILLS`, `EXCLUDED_SKILL_DIRS`, `SKILL_SUPPORT_DIRS`), [`gateway/run.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/gateway/run.py) (`_CACHE_BUSTING_CONFIG_KEYS`) |
| Skill files | `$HERMES_HOME/skills/**/SKILL.md`, YAML front matter `name` (else the folder name) and `description`; folders `.git .hub .archive … node_modules __pycache__` are skipped, and `references templates assets scripts` inside a skill are not skills. | `agent/skill_utils.py` (`parse_frontmatter`, `iter_skill_index_files`) |
| Memory | `$HERMES_HOME/memories/MEMORY.md` (the agent's notes) and `USER.md` (about the user); entries joined by `"\n§\n"`, each stripped; writes take an exclusive lock on `<file>.lock` and replace the file atomically; a file that does not round-trip is treated as edited outside Hermes. The prompt snapshot is frozen per session. | [`tools/memory_tool_store.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/tools/memory_tool_store.py), [`tools/memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/tools/memory_tool.py) |
| Models | `model.provider` + `model.default`; the fallback chain **merges** both keys, `fallback_providers` first and then the legacy `fallback_model` (single dict or list), so clearing the fallback must clear both. | [`website/docs/user-guide/features/fallback-providers.md`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/website/docs/user-guide/features/fallback-providers.md), [`hermes_cli/config.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/hermes_cli/config.py) |
| Keys | DeepSeek reads `DEEPSEEK_API_KEY`, OpenRouter `OPENROUTER_API_KEY`, through `get_env_value_prefer_dotenv`: **`$HERMES_HOME/.env` first, then `os.environ`** (via `secret_scope.get_secret`, which explicitly supports process-env injection in single-profile gateways; only profile multiplexing would block it). | [`plugins/model-providers/deepseek/__init__.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/plugins/model-providers/deepseek/__init__.py), [`hermes_cli/auth.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/hermes_cli/auth.py) (`_resolve_api_key_provider_secret`), [`agent/secret_scope.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/agent/secret_scope.py) |
| Restart | "Every turn re-resolves the config and the credentials", and the cached agent's signature hashes the model and the full API key, so a new key in the environment or a new `model.default` rebuilds the agent at the next message — **no gateway restart**. Env-backed credential-pool rows are written to `auth.json` **without** the secret. Both keys are on the blocklist that keeps them out of the terminal tool's child processes. | [`gateway/AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/gateway/AGENTS.md), [`gateway/run_agent_cache.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/gateway/run_agent_cache.py) (`_agent_config_signature`), [`agent/credential_pool.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/agent/credential_pool.py), [`tools/environments/local_env_policy.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/tools/environments/local_env_policy.py) |
| YAML | Hermes parses with `ruamel.yaml` (pinned 0.18.16); its deps pin `aiohttp==3.14.3` and `cryptography==50.0.1`. | [`hermes_yaml.py`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/hermes_yaml.py), [`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/46904a3b467f62616f5b3ee247adce30b1b277a0/pyproject.toml) |
| Persona | `$HERMES_HOME/SOUL.md`. | `docker/SOUL.md`, `hermes_cli/default_soul.py` |

The TC Hermes runs the Trismegisto's **pinned digest**, possibly older than `main`. The plugin checks the files' shape before touching anything (spec §3 "Versão fixa") and supports both fallback keys; Task R verifies on that digest that a new model and key apply at the next message (if not, the plugin's opt-in `GHOSTLINK_COMPANY_RESTART=s6` restarts the gateway after a change, and the keys come back with the next `hermes.config`).

## Decisions where the spec left room

1. Error codes follow the codebase style: `ENTERPRISE_REQUIRED` (spec `enterprise_required`), plus `LICENSE_INVALID` (unreadable, forged, another server) and `LICENSE_EXPIRED` (past the 7-day grace).
2. The company Hermes is created with a new owner request `hermes.create { name }` (the spec lists only get/update/memory.delete).
3. Memory deletion reaches the plugin as the event `hermes.memory.delete { target, id }`; items carry `id` = first 16 hex of SHA-256 of the entry. `BOT_OFFLINE` while the Hermes is disconnected.
4. Keys never touch the Hermes disk (owner rule above, supersedes spec §3 "chaves no `.env`"). A key in Hermes's own `.env` would win: the plugin reports it (`envOverride`) and the panel says so. No restart by default (facts above).
5. OpenRouter's model list needs no key, so its key is tested on `GET https://openrouter.ai/api/v1/key` (free, no tokens); DeepSeek's on `GET https://api.deepseek.com/models`.
6. "The DJ disappears" = its member is **parked**: `removed_at` set (member.left, offline), roles kept for its return, commands cleared (`commands.updated` with none), its `dj.*` requests answer `NOT_FOUND`. Back as normal: member.joined and its commands again. Equalizer, volume and cookies untouched.
7. The company Hermes is refused **at the handshake** (no presence flicker): the enterprise module mirrors the edition into the `enterprise.edition` column, read by `auth/botAuth.ts`.
8. Only the **owner** may regenerate the company Hermes's code or delete it: whoever holds that code receives the company's keys.
9. `disabledSkills: null` means "Hermes keeps its own list" until the owner switches a skill; then GhostLink's list is authoritative.
10. Deleting the company Hermes keeps its settings and keys (`bot_id` becomes NULL); a new "Hermes da empresa" picks them up. The owner can delete keys in the panel.
11. Spec §6 "Ponta a ponta" is a test with a **real server and the plugin's real code** (Python) driven by the owner's requests exactly as the app sends them; the UI is covered by unit tests of its pure helpers. No Electron e2e (CI does not run e2e).
12. Both new modules are registered in every server, the desktop Hosting mode included; Enterprise there stays unsupported and untested (spec "Fora deste desenho").

## File map

| Owner | Files |
|---|---|
| Task 1 (contract) | `packages/shared/src/{license,enterprise,companyHermes}.ts` (new), `packages/shared/src/{errors,constants,index}.ts`, `packages/shared/test/license.test.ts` (new), `apps/server/src/db/migrations/009_enterprise.sql` (new), `apps/server/src/enterprise/index.ts` (stub), `apps/server/src/companyHermes/index.ts` (stub), `apps/server/src/defaultModules.ts`, `apps/server/src/bots/index.ts` (`createBot`, owner guard), `apps/server/test/helpers/{license,enterprise}.ts` (new), `apps/desktop/src/renderer/i18n/enterprise.{pt-BR,en}.ts` (new, error strings), `apps/desktop/src/renderer/i18n/{pt-BR,en}.ts` (spread), `.gitignore` |
| Track A | `scripts/lib/license.mjs`, `scripts/gen-license-key.mjs`, `scripts/issue-license.mjs`, `scripts/test/license.test.ts` (new), `scripts/tsconfig.json`; `apps/server/src/enterprise/**`; `apps/server/src/bots/index.ts` (`setHidden`), `apps/server/src/text/bots.ts` (`park`/`unpark`); `apps/server/src/ghostDj/index.ts`, `apps/server/src/ghostDj/dj.ts` (`leave()` only); tests `apps/server/test/enterprise.test.ts` (new), `apps/server/test/ghostDj.test.ts` (setup option + one describe) |
| Track B | `apps/server/src/companyHermes/**`, `apps/server/src/auth/botAuth.ts` (one check); test `apps/server/test/companyHermes.test.ts` (new) |
| Track C | `apps/desktop/src/renderer/stores/enterprise.ts` (new), `apps/desktop/src/renderer/features/enterprise/**` (new), `apps/desktop/src/renderer/features/bots/hermes/**` (new), `apps/desktop/src/renderer/features/bots/{BotSettings,BotsSection,BotDialogs}.tsx`, `apps/desktop/src/renderer/features/server-settings/{ServerSettings.tsx,access.ts}`, `apps/desktop/src/renderer/layout/{ChannelSidebar,MainLayout}.tsx`, `apps/desktop/src/main/ipc.ts` (request types), `apps/desktop/src/renderer/i18n/enterprise.{pt-BR,en}.ts` (more keys); tests `apps/desktop/test/renderer/{enterprise,hermesModel}.test.ts` (new), `apps/desktop/test/renderer/i18n.test.ts` (one allowlist) |
| Track D | `integrations/hermes-agent/ghostlink/{company.py (new),adapter.py,client.py,plugin.yaml}`, `integrations/hermes-agent/README.md`, `integrations/hermes-agent/test/{company_check.py,company.test.ts}` (new), `.github/workflows/ci.yml`, `scripts/test/ciWorkflow.test.ts` |
| Integration (main session) | `integrations/hermes-agent/test/{company_e2e.py,company-hermes.test.ts}` (new), `apps/server/src/MODULES.md`, `docs/checklist-teste.md`, `release-notes/0.6.0.md`, version bump |

Tracks A–D only depend on the contract. Track B's tests use `fakeEnterprise()` (contract), so they never wait for Track A.

---

## Task 0: Merge main (v0.5.2) into v0.6.0-dev — main session

v0.5.2 (call sounds, the DJ cookies button, the DJ without RED; spec `docs/superpowers/specs/2026-10-02-sons-da-chamada-e-cookies-do-dj-design.md`) touches `apps/server/src/ghostDj/{index,dj,livekitOutput}.ts`, `packages/shared/src/ghostDj.ts`, `DjPanel.tsx`, the voice renderer and the `bots`/`voice` i18n files. This plan only **adds** to `ghostDj/index.ts` and `dj.ts` (a hide switch and a `leave()` method) and wraps every DJ handler generically, so v0.5.2's `dj.cookies.set` / `dj.cookies.clear` are refused while hidden too, and the cookies file stays.

- [ ] **Step 1: Merge**

```bash
git fetch origin
git merge --no-ff origin/main -m "Merge main (v0.5.2) into v0.6.0-dev"
```

Expected: a clean merge (v0.6.0-dev holds only the spec and this plan).

- [ ] **Step 2: Check the next migration number**

```bash
ls apps/server/src/db/migrations
```

Expected: the last file is `008_ghost_dj_eq.sql`, so this plan's file is `009_enterprise.sql`. If v0.5.2 added one, use the next free number everywhere this plan says `009` (MODULES.md: numbering stays contiguous).

- [ ] **Step 3: Push nothing yet.** The tracks start after Task 1.

---

## Task 1: The contract — one agent, before the tracks

**Files:** see the File map's first row.

- [ ] **Step 1: Error codes and the license label**

`packages/shared/src/errors.ts`, append to `ERROR_CODES` (after `'BAD_BOT_TOKEN', 'BOT_OFFLINE',`):

```ts
  // Enterprise (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): a change that needs an
  // Enterprise server (the company Hermes is refused at a normal one with it too); a license that is
  // not one, is forged or is for another server; a license past its 7 days of grace.
  'ENTERPRISE_REQUIRED', 'LICENSE_INVALID', 'LICENSE_EXPIRED',
```

`packages/shared/src/constants.ts`, after `OWNER_STATUS_LABEL`:

```ts
/**
 * Domain label of an Enterprise license signature (license.ts). Outside CRYPTO_LABELS, which is
 * frozen, but just as fixed: every license ever issued is signed over it.
 */
export const LICENSE_LABEL = 'ghostlink-license-v1';
```

- [ ] **Step 2: Write the failing license test**

`packages/shared/test/license.test.ts`:

```ts
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LICENSE_LIMITS, checkLicense, formatLicense, grantsEnterprise, parseLicense, toBase64Url, utf8, type LicenseData } from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 15);
const SERVER = 'S'.repeat(43);
// Made for this run only: never a real license key.
const key = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

const data = (o: Partial<LicenseData> = {}): LicenseData => ({ v: 1, company: 'TC Flag', serverKeyId: SERVER, issuedAt: NOW - DAY, expiresAt: NOW + 30 * DAY, ...o });
const issue = (d: LicenseData = data(), k: KeyObject = key.privateKey) => formatLicense(d, (input) => sign(null, input, k));
const check = (text: string, now = NOW) =>
  checkLicense(text, { serverKeyId: SERVER, now, verify: (signed, signature) => verify(null, signed, key.publicKey, signature) });

describe('Enterprise licenses (spec §1)', () => {
  it('a license for this server is valid, and reads back as issued', () => {
    const text = issue();
    expect(text).toMatch(/^GLE1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    expect(check(text)).toEqual({ state: 'valid', data: data() });
    expect(check(`  ${text}\n`).state).toBe('valid');
  });

  it('warns in the last 7 days, stays Enterprise 7 days past expiry, then expires', () => {
    const expiresAt = NOW + 30 * DAY;
    const text = issue();
    expect(check(text, expiresAt - LICENSE_LIMITS.warnBeforeMs - 1).state).toBe('valid');
    expect(check(text, expiresAt - LICENSE_LIMITS.warnBeforeMs).state).toBe('expiring');
    expect(check(text, expiresAt + 1).state).toBe('grace');
    expect(check(text, expiresAt + LICENSE_LIMITS.graceMs).state).toBe('grace');
    expect(check(text, expiresAt + LICENSE_LIMITS.graceMs + 1).state).toBe('expired');
    expect((['valid', 'expiring', 'grace'] as const).every(grantsEnterprise)).toBe(true);
    expect((['expired', 'wrong-server', 'invalid'] as const).some(grantsEnterprise)).toBe(false);
  });

  it('a license copied to another server does not count there', () => {
    expect(check(issue(data({ serverKeyId: 'T'.repeat(43) })))).toMatchObject({ state: 'wrong-server', data: { company: 'TC Flag' } });
  });

  it('a forged license is invalid: another key, or data changed after signing', () => {
    expect(check(issue(data(), other.privateKey))).toEqual({ state: 'invalid', data: null });
    const [prefix, , signature] = issue().split('.');
    const changed = toBase64Url(utf8(JSON.stringify({ ...data(), company: 'Outra' })));
    expect(check(`${prefix}.${changed}.${signature}`).state).toBe('invalid');
  });

  it.each([
    ['empty', ''],
    ['prefix only', 'GLE1'],
    ['another version', issue().replace(/^GLE1/, 'GLE2')],
    ['an extra part', `${issue()}.x`],
    ['not base64url', 'GLE1.%%%.' + 'A'.repeat(86)],
    ['not JSON', `GLE1.${toBase64Url(utf8('oi'))}.${'A'.repeat(86)}`],
    ['an unknown field', `GLE1.${toBase64Url(utf8(JSON.stringify({ ...data(), extra: 1 })))}.${'A'.repeat(86)}`],
    ['expires before issued', issue(data({ expiresAt: NOW - 2 * DAY }))],
    ['a short signature', issue().slice(0, -2)],
    ['too long', `GLE1.${'A'.repeat(LICENSE_LIMITS.maxLength)}.${'A'.repeat(86)}`],
  ])('a broken license (%s) is invalid', (_why, text) => {
    expect(parseLicense(text)).toBeNull();
    expect(check(text)).toEqual({ state: 'invalid', data: null });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -- packages/shared/test/license.test.ts`
Expected: FAIL — `formatLicense` (and the rest) are not exported.

- [ ] **Step 4: Write `packages/shared/src/license.ts`**

```ts
// Enterprise licenses (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1). Pure data and
// parsing: the server checks the signature with node:crypto (apps/server/src/enterprise/), the
// owner's scripts sign (scripts/lib/license.mjs mirrors formatLicense byte for byte).
import { z } from 'zod';
import { LICENSE_LABEL } from './constants.js';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';

/**
 * Raw 32-byte Ed25519 public key of the LICENSE key (its own key, never the release key),
 * base64url. Its private half lives only on the owner's PC (D:\GhostLink Licencas\), made once by
 * scripts/gen-license-key.mjs. Empty until that ceremony: every license is refused.
 */
export const LICENSE_PUBLIC_KEY: string = '';

export const LICENSE_PREFIX = 'GLE1';

export const LICENSE_LIMITS = {
  /** The whole `GLE1.<data>.<signature>` text. */
  maxLength: 2048,
  companyMax: 100,
  /** Still Enterprise this long after `expiresAt` (the owner is warned). */
  graceMs: 7 * 86_400_000,
  /** The owner is warned this long before `expiresAt`. */
  warnBeforeMs: 7 * 86_400_000,
} as const;

/** What a license says. Dates are ms epoch; the server's clock decides. */
export interface LicenseData {
  v: 1;
  company: string;
  /** The server it is for: its TLS key pin, as in invites (base64url SHA-256 of the SPKI). */
  serverKeyId: string;
  issuedAt: number;
  expiresAt: number;
}

export const licenseDataSchema: z.ZodType<LicenseData> = z
  .strictObject({
    v: z.literal(1),
    company: z.string().min(1).max(LICENSE_LIMITS.companyMax),
    serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((d) => d.expiresAt > d.issuedAt, 'expires before it was issued');

const DATA_SEGMENT = /^[A-Za-z0-9_-]{1,2000}$/;
const SIGNATURE_SEGMENT = /^[A-Za-z0-9_-]{86}$/;

/** The bytes the license key signs: UTF-8 of "ghostlink-license-v1\n" + the base64url data segment (no '\n' can hide in it). */
export function licenseSigningInput(dataSegment: string): Uint8Array {
  if (!DATA_SEGMENT.test(dataSegment)) throw new ProtocolError('BAD_REQUEST', 'invalid license data');
  return utf8(`${LICENSE_LABEL}\n${dataSegment}`);
}

/** `GLE1.<data>.<signature>`; `sign` returns the raw 64-byte Ed25519 signature of its input. */
export function formatLicense(data: LicenseData, sign: (input: Uint8Array) => Uint8Array): string {
  const json = JSON.stringify({ v: data.v, company: data.company, serverKeyId: data.serverKeyId, issuedAt: data.issuedAt, expiresAt: data.expiresAt });
  const segment = toBase64Url(utf8(json));
  return `${LICENSE_PREFIX}.${segment}.${toBase64Url(sign(licenseSigningInput(segment)))}`;
}

export interface ParsedLicense {
  data: LicenseData;
  /** licenseSigningInput(<data segment>). */
  signed: Uint8Array;
  signature: Uint8Array;
}

/** Reads a license (spaces around it allowed); null when it is not one. Does not check the signature. */
export function parseLicense(text: unknown): ParsedLicense | null {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s.length === 0 || s.length > LICENSE_LIMITS.maxLength) return null;
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  const segment = parts[1]!;
  const sig = parts[2]!;
  if (!DATA_SEGMENT.test(segment) || !SIGNATURE_SEGMENT.test(sig)) return null;
  try {
    const parsed = licenseDataSchema.safeParse(JSON.parse(fromUtf8(fromBase64Url(segment))));
    const signature = fromBase64Url(sig);
    if (!parsed.success || signature.length !== 64) return null;
    return { data: parsed.data, signed: licenseSigningInput(segment), signature };
  } catch {
    return null;
  }
}

/**
 * Where a license stands for one server now:
 * - invalid: not a license, or a signature the license key did not make;
 * - wrong-server: signed, but for another server;
 * - valid; expiring (its last 7 days); grace (the 7 days after expiresAt): Enterprise;
 * - expired: past the grace, the server is normal again.
 */
export const LICENSE_STATES = ['valid', 'expiring', 'grace', 'expired', 'wrong-server', 'invalid'] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

export interface LicenseCheck {
  state: LicenseState;
  /** The license's data once its signature checked out (every state but invalid). */
  data: LicenseData | null;
}

export function checkLicense(
  text: unknown,
  opts: { serverKeyId: string; now: number; verify: (signed: Uint8Array, signature: Uint8Array) => boolean },
): LicenseCheck {
  const parsed = parseLicense(text);
  if (!parsed || !opts.verify(parsed.signed, parsed.signature)) return { state: 'invalid', data: null };
  const { data } = parsed;
  if (data.serverKeyId !== opts.serverKeyId) return { state: 'wrong-server', data };
  if (opts.now > data.expiresAt + LICENSE_LIMITS.graceMs) return { state: 'expired', data };
  if (opts.now > data.expiresAt) return { state: 'grace', data };
  if (opts.now >= data.expiresAt - LICENSE_LIMITS.warnBeforeMs) return { state: 'expiring', data };
  return { state: 'valid', data };
}

/** The license makes the server Enterprise (spec §1: until its validity plus 7 days). */
export function grantsEnterprise(state: LicenseState): boolean {
  return state === 'valid' || state === 'expiring' || state === 'grace';
}
```

- [ ] **Step 5: Write `packages/shared/src/enterprise.ts`**

```ts
// Enterprise servers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): the edition
// everyone sees, and the license as its owner sees it. The license text never comes back.
//
// Request (the owner only): `enterprise.license.set { license }` → EnterpriseState. FORBIDDEN for
// anyone else; LICENSE_INVALID (unreadable, forged or for another server); LICENSE_EXPIRED (past the
// 7 days of grace). Stored only when it makes the server Enterprise; it replaces the old one at once.
// Welcome key `enterprise` and event `enterprise.state`: EnterpriseState, sent to everyone when the
// edition changes and to the owner when the license's state does.
import { z } from 'zod';
import { LICENSE_LIMITS, LICENSE_STATES, type LicenseState } from './license.js';

/** welcome.features: the server has editions (an older app ignores them). */
export const FEATURE_ENTERPRISE = 'enterprise';

export const EDITIONS = ['normal', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];

/** The stored license, for the owner only. */
export interface EnterpriseLicenseInfo {
  state: LicenseState;
  /** null when it could not be read (state invalid). */
  company: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  /** Enterprise until then: expiresAt + 7 days. */
  graceEndsAt: number | null;
}

/** The edition for everyone; `license` for the owner only (null: none pasted). */
export interface EnterpriseState {
  edition: Edition;
  license?: EnterpriseLicenseInfo | null;
}

export interface EnterpriseLicenseSetPayload {
  license: string;
}

export const ENTERPRISE_LIMITS = {
  /** enterprise.license.set per owner per minute. */
  licenseSetsPerMinute: 10,
} as const;

// ---- server side: strict ----

export const enterpriseLicenseSetSchema = z.strictObject({ license: z.string().min(1).max(LICENSE_LIMITS.maxLength + 256) });

// ---- client side: lenient ----

export const enterpriseLicenseInfoSchemaClient: z.ZodType<EnterpriseLicenseInfo> = z.object({
  state: z.enum(LICENSE_STATES).catch('invalid'),
  company: z.string().max(200).nullable().catch(null),
  issuedAt: z.number().nullable().catch(null),
  expiresAt: z.number().nullable().catch(null),
  graceEndsAt: z.number().nullable().catch(null),
});

export const enterpriseStateSchemaClient: z.ZodType<EnterpriseState> = z.object({
  edition: z.enum(EDITIONS).catch('normal'),
  license: enterpriseLicenseInfoSchemaClient.nullable().optional().catch(undefined),
});
```

- [ ] **Step 6: Write `packages/shared/src/companyHermes.ts`**

```ts
// The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2, §3): one
// bot per Enterprise server, marked by the server, which gets the company's settings and AI keys
// through its pinned bot session. Payloads, events, strict server schemas, lenient client schemas.
//
// Owner requests (FORBIDDEN for anyone else; changes need an Enterprise server: ENTERPRISE_REQUIRED):
//   - `hermes.create { name }` → BotCreateResult: a bot marked as the company Hermes, one per
//     server (BAD_REQUEST when it exists); its connection code shows once, as for any bot.
//   - `hermes.get {}` → HermesState (on a normal server too, with `locked`).
//   - `hermes.update { keys?, models?, disabledSkills?, access? }` → HermesState.
//   - `hermes.memory.delete { target, id }` → {} (BOT_OFFLINE while the Hermes is disconnected).
// To the company Hermes's session only: `hermes.config` (HermesConfig, keys included) when it
//   connects and after every change; `hermes.memory.delete` (HermesMemoryDelete).
// From the company Hermes only: `hermes.report` (HermesReport) → {}.
// To the owner's sessions: `hermes.state` (HermesState); the owner's welcome carries `hermes`.
// Only the owner may regenerate the company Hermes's code or delete it (bot.regenerate / bot.delete).
import { z } from 'zod';
import { entityIdSchema } from './chat.js';

export const FEATURE_ENTERPRISE_HERMES = 'enterpriseHermes';

export const HERMES_PROVIDERS = ['deepseek', 'openrouter'] as const;
export type HermesProvider = (typeof HERMES_PROVIDERS)[number];

export const HERMES_LIMITS = {
  keyMax: 512,
  modelMax: 128,
  maxSkills: 200,
  skillNameMax: 64,
  skillDescriptionMax: 200,
  /** Per memory file (MEMORY.md: about the company; USER.md: about the people). */
  maxMemoryItems: 60,
  memoryItemMax: 1000,
  maxRoles: 250,
  maxChannels: 500,
  /** hermes.update and hermes.memory.delete per owner per minute. */
  changesPerMinute: 20,
  /** hermes.report per Hermes per minute. */
  reportsPerMinute: 30,
} as const;

export interface HermesModelRef {
  provider: HermesProvider;
  model: string;
}

export interface HermesAccess {
  /** Roles whose members may talk to it; the owner always may. */
  roleIds: string[];
  /** Where it answers (still only when mentioned or replied to). */
  channels: 'all' | string[];
}

export interface HermesSettings {
  models: { primary: HermesModelRef; fallback: HermesModelRef | null };
  /** Skills switched off; null: Hermes keeps its own list until the owner switches one. */
  disabledSkills: string[] | null;
  access: HermesAccess;
}

/** Spec §2 "Modelos": today's default. */
export const HERMES_DEFAULT_SETTINGS: HermesSettings = {
  models: { primary: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' } },
  disabledSkills: null,
  access: { roleIds: [], channels: 'all' },
};

/** `hermes.config`: everything the Hermes should be, keys included. A secret: never logged. */
export interface HermesConfig extends HermesSettings {
  /** Bumped by every hermes.update; the report names the one applied. */
  version: number;
  keys: Record<HermesProvider, string | null>;
}

export interface HermesSkill {
  name: string;
  description: string;
  enabled: boolean;
  /** Hermes never turns it off (`hermes-agent`). */
  locked: boolean;
}

export type HermesMemoryTarget = 'company' | 'people';

export interface HermesMemoryItem {
  /** The first 16 hex of the SHA-256 of the whole entry. */
  id: string;
  text: string;
}

export const HERMES_KEY_STATUSES = ['ok', 'refused', 'unreachable', 'missing', 'unchecked'] as const;
export type HermesKeyStatus = (typeof HERMES_KEY_STATUSES)[number];

/** A model as Hermes's config.yaml has it now (its provider may be one GhostLink does not manage). */
export interface HermesModelInUse {
  provider: string;
  model: string;
}

export interface HermesStatus {
  model: HermesModelInUse | null;
  fallback: HermesModelInUse | null;
  /** Each key as the provider's free listing answered (no tokens spent). */
  keys: Record<HermesProvider, HermesKeyStatus>;
  /** Set when the plugin applied nothing ("versão do Hermes não suportada"), with the reason. */
  unsupported: string | null;
  /** Providers whose key is also in Hermes's own .env, which wins over GhostLink's. */
  envOverride: HermesProvider[];
}

export interface HermesReport {
  appliedVersion: number;
  skills: HermesSkill[];
  memory: Record<HermesMemoryTarget, HermesMemoryItem[]>;
  status: HermesStatus;
}

export interface HermesMemoryDelete {
  target: HermesMemoryTarget;
  id: string;
}

/** What the owner's settings show. Keys appear only as their last 4 characters. */
export interface HermesState {
  /** The company Hermes's member id; null: none yet, or deleted (its settings stay for the next). */
  botId: string | null;
  /** It has a session now. */
  connected: boolean;
  /** The server is not Enterprise: shown, but changes are refused. */
  locked: boolean;
  keys: Record<HermesProvider, { last4: string } | null>;
  settings: HermesSettings;
  version: number;
  /** The last report, kept while it is disconnected. */
  report: HermesReport | null;
  reportAt: number | null;
}

export interface HermesUpdatePayload {
  /** A key, or null to delete it; absent: unchanged. */
  keys?: Partial<Record<HermesProvider, string | null>>;
  models?: HermesSettings['models'];
  disabledSkills?: string[];
  access?: HermesAccess;
}

// ---- server side: strict ----

const provider = z.enum(HERMES_PROVIDERS);
const modelName = z.string().regex(/^[A-Za-z0-9._:/@-]{1,128}$/);
const modelRef = z.strictObject({ provider, model: modelName });
/** Printable ASCII without spaces; a pasted key's surrounding spaces are dropped. */
const keyValue = z.string().trim().regex(/^[\x21-\x7e]{8,512}$/);
const skillName = z.string().min(1).max(HERMES_LIMITS.skillNameMax).regex(/^[^\u0000-\u001f\u007f]+$/);
const memoryId = z.string().regex(/^[0-9a-f]{16}$/);
const memoryTarget = z.enum(['company', 'people']);

export const hermesModelsSchema = z.strictObject({ primary: modelRef, fallback: modelRef.nullable() });
export const hermesAccessSchema = z.strictObject({
  roleIds: z.array(entityIdSchema).max(HERMES_LIMITS.maxRoles),
  channels: z.union([z.literal('all'), z.array(entityIdSchema).max(HERMES_LIMITS.maxChannels)]),
});
/** The stored settings (the server's own data, read back). */
export const hermesSettingsSchema: z.ZodType<HermesSettings> = z.strictObject({
  models: hermesModelsSchema,
  disabledSkills: z.array(skillName).max(HERMES_LIMITS.maxSkills).nullable(),
  access: hermesAccessSchema,
});

export const hermesCreateSchema = z.strictObject({ name: z.string().min(1).max(64) });
export const hermesGetSchema = z.strictObject({});
export const hermesUpdateSchema = z
  .strictObject({
    keys: z.strictObject({ deepseek: keyValue.nullable().optional(), openrouter: keyValue.nullable().optional() }).optional(),
    models: hermesModelsSchema.optional(),
    disabledSkills: z.array(skillName).max(HERMES_LIMITS.maxSkills).optional(),
    access: hermesAccessSchema.optional(),
  })
  .refine((p) => p.keys !== undefined || p.models !== undefined || p.disabledSkills !== undefined || p.access !== undefined, 'nothing to update');
export const hermesMemoryDeleteSchema = z.strictObject({ target: memoryTarget, id: memoryId });

const reportModel = z.strictObject({ provider: z.string().max(64), model: z.string().max(HERMES_LIMITS.modelMax) }).nullable();
const memoryItems = z.array(z.strictObject({ id: memoryId, text: z.string().max(HERMES_LIMITS.memoryItemMax) })).max(HERMES_LIMITS.maxMemoryItems);
const keyStatus = z.enum(HERMES_KEY_STATUSES);
export const hermesReportSchema: z.ZodType<HermesReport> = z.strictObject({
  appliedVersion: z.number().int().nonnegative(),
  skills: z
    .array(z.strictObject({ name: skillName, description: z.string().max(HERMES_LIMITS.skillDescriptionMax), enabled: z.boolean(), locked: z.boolean() }))
    .max(HERMES_LIMITS.maxSkills),
  memory: z.strictObject({ company: memoryItems, people: memoryItems }),
  status: z.strictObject({
    model: reportModel,
    fallback: reportModel,
    keys: z.strictObject({ deepseek: keyStatus, openrouter: keyStatus }),
    unsupported: z.string().max(200).nullable(),
    envOverride: z.array(provider).max(HERMES_PROVIDERS.length),
  }),
});

// ---- client side: lenient ----

const modelRefClient = z.object({ provider: z.enum(HERMES_PROVIDERS), model: z.string().max(256) });
const modelInUseClient = z.object({ provider: z.string().max(64), model: z.string().max(256) }).nullable().catch(null);
const keyStatusClient = z.enum(HERMES_KEY_STATUSES).catch('unchecked');
const memoryClient = z.array(z.object({ id: z.string().max(32), text: z.string().max(4_000) })).max(500).catch([]);
const lastFour = z.object({ last4: z.string().max(8) }).nullable().catch(null);

export const hermesReportSchemaClient: z.ZodType<HermesReport> = z.object({
  appliedVersion: z.number().int().nonnegative().catch(0),
  skills: z
    .array(z.object({ name: z.string().max(256), description: z.string().max(1_000).catch(''), enabled: z.boolean().catch(true), locked: z.boolean().catch(false) }))
    .max(1_000)
    .catch([]),
  memory: z.object({ company: memoryClient, people: memoryClient }).catch({ company: [], people: [] }),
  status: z
    .object({
      model: modelInUseClient,
      fallback: modelInUseClient,
      keys: z.object({ deepseek: keyStatusClient, openrouter: keyStatusClient }).catch({ deepseek: 'unchecked', openrouter: 'unchecked' }),
      unsupported: z.string().max(400).nullable().catch(null),
      envOverride: z.array(z.enum(HERMES_PROVIDERS)).max(4).catch([]),
    })
    .catch({ model: null, fallback: null, keys: { deepseek: 'unchecked', openrouter: 'unchecked' }, unsupported: null, envOverride: [] }),
});

export const hermesStateSchemaClient: z.ZodType<HermesState> = z.object({
  botId: z.string().max(64).nullable().catch(null),
  connected: z.boolean().catch(false),
  locked: z.boolean().catch(true),
  keys: z.object({ deepseek: lastFour, openrouter: lastFour }).catch({ deepseek: null, openrouter: null }),
  settings: z
    .object({
      models: z.object({ primary: modelRefClient, fallback: modelRefClient.nullable().catch(null) }).catch(HERMES_DEFAULT_SETTINGS.models),
      disabledSkills: z.array(z.string().max(256)).max(1_000).nullable().catch(null),
      access: z
        .object({
          roleIds: z.array(z.string().max(64)).max(1_000).catch([]),
          channels: z.union([z.literal('all'), z.array(z.string().max(64)).max(1_000)]).catch('all'),
        })
        .catch(HERMES_DEFAULT_SETTINGS.access),
    })
    .catch(HERMES_DEFAULT_SETTINGS),
  version: z.number().int().nonnegative().catch(0),
  report: hermesReportSchemaClient.nullable().catch(null),
  reportAt: z.number().nullable().catch(null),
});
```

- [ ] **Step 7: Export them**

`packages/shared/src/index.ts`, append:

```ts
export * from './license.js';
export * from './enterprise.js';
export * from './companyHermes.js';
```

- [ ] **Step 8: Run the license test**

Run: `npm test -- packages/shared/test/license.test.ts`
Expected: PASS (all cases).

- [ ] **Step 9: The migration**

`apps/server/src/db/migrations/009_enterprise.sql`:

```sql
-- Enterprise and the company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md
-- §1, §2; src/enterprise/, src/companyHermes/). Never edit after merge.
-- enterprise: one row. license: the GLE1.… text the owner pasted (checked when pasted, at start and
--   every hour); edition: the result, written by the enterprise module and read by the bot handshake
--   (auth/botAuth.ts: the company Hermes needs an Enterprise server).
CREATE TABLE enterprise (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license TEXT CHECK (license IS NULL OR length(license) <= 4096),
  set_by TEXT,
  set_at INTEGER,
  edition TEXT NOT NULL DEFAULT 'normal' CHECK (edition IN ('normal', 'enterprise'))
) STRICT;

-- company_hermes: one row. bot_id: the bot marked as the company Hermes (NULL once deleted: the
--   settings stay for the next one). deepseek_key / openrouter_key: the company's AI keys, secrets:
--   they go only to that bot's session (hermes.config), never back to an app, never to the logs; the
--   server's erase empties this table like every other. settings: HermesSettings as JSON. version:
--   bumped by every hermes.update. report / report_at: the last hermes.report, JSON.
CREATE TABLE company_hermes (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT UNIQUE REFERENCES bots(user_id) ON DELETE SET NULL,
  deepseek_key TEXT CHECK (deepseek_key IS NULL OR length(deepseek_key) <= 512),
  openrouter_key TEXT CHECK (openrouter_key IS NULL OR length(openrouter_key) <= 512),
  settings TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  report_at INTEGER
) STRICT;
```

- [ ] **Step 10: The module stubs and their registration**

`apps/server/src/enterprise/index.ts` (Track A replaces `createEnterpriseModule`'s body; everything else is the contract):

```ts
import type { Edition } from '@ghostlink/shared';
import type { ModuleContext, ServerModule } from '../modules.js';

export const ENTERPRISE_MODULE_NAME = 'enterprise';

/**
 * Enterprise servers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): the license,
 * `enterprise.license.set`, the welcome's `enterprise` and the `enterprise.state` event. Register
 * after text, before companyHermes and ghostDj (they read the edition in their init).
 */
export interface EnterpriseModule extends ServerModule {
  readonly name: typeof ENTERPRISE_MODULE_NAME;
  /** 'enterprise' while the stored license is valid for this server, up to 7 days past its validity. */
  readonly edition: Edition;
  /** Runs after each change of edition (pasted, renewed, lapsed); returns the unsubscribe. */
  onChange(listener: (edition: Edition) => void): () => void;
  /** Checks the stored license again now (it also runs at start, when one is pasted and every hour). */
  recheck(): void;
}

export interface EnterpriseModuleOptions {
  /** The license public key (raw base64url); default LICENSE_PUBLIC_KEY. Tests pass a key made for the run. */
  publicKey?: string;
  /** How often the license is checked again; default 1 h. */
  checkEveryMs?: number;
}

/** The enterprise module, or null where a test server runs without it (then the server is normal). */
export function enterpriseOf(ctx: Pick<ModuleContext, 'getModule'>): EnterpriseModule | null {
  try {
    return ctx.getModule<EnterpriseModule>(ENTERPRISE_MODULE_NAME);
  } catch {
    return null;
  }
}

/** Contract stub: always normal (Track A). */
export function createEnterpriseModule(_opts: EnterpriseModuleOptions = {}): EnterpriseModule {
  return { name: ENTERPRISE_MODULE_NAME, edition: 'normal', onChange: () => () => {}, recheck: () => {} };
}
```

`apps/server/src/companyHermes/index.ts`:

```ts
import type { ServerModule } from '../modules.js';

export const COMPANY_HERMES_MODULE_NAME = 'companyHermes';

/**
 * The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2). Register
 * after bots and enterprise.
 */
export interface CompanyHermesModule extends ServerModule {
  readonly name: typeof COMPANY_HERMES_MODULE_NAME;
}

/** Contract stub (Track B). */
export function createCompanyHermesModule(): CompanyHermesModule {
  return { name: COMPANY_HERMES_MODULE_NAME };
}
```

`apps/server/src/defaultModules.ts`: import both factories and register them right after `createBotsModule()`:

```ts
    createBotsModule(),
    createEnterpriseModule(),
    createCompanyHermesModule(),
    ...(opts.ghostDj === false ? [] : [createGhostDjModule()]),
```

and add to the order comment:

```ts
  // Enterprise after text (the owner, the sessions); the company Hermes after bots and enterprise
  // (its bot, the edition); the Ghost DJ after enterprise (it hides in an Enterprise server).
```

- [ ] **Step 11: `createBot` and the owner guard in the bots module**

`apps/server/src/bots/index.ts`:

1. Add to `BotsModule`:

```ts
  /**
   * `bot.create` for another module (the company Hermes, src/companyHermes/): the same checks
   * (MANAGE_SERVER, the bot limit, NICK_TAKEN, the rate limit) and the same answer, for rc's user.
   */
  createBot(rc: RequestContext, name: string): BotCreateResult;
```

2. Move the body of the `'bot.create'` handler (from `const s = need();` to the `return`) into a closure, with `p.name` replaced by `name`:

```ts
  const createBot = (ctx: RequestContext, name: string): BotCreateResult => {
    const s = need();
    requireManager(s, ctx.userId);
    const nick = normalizeNickname(name);
    // …the rest of the old handler body, unchanged…
  };
```

and make the handler `'bot.create': (ctx, payload): BotCreateResult => createBot(ctx, botCreateSchema.parse(payload).name),`. Return `createBot` from the factory next to `ensureSystemBot`.

3. Add the guard and call it in `'bot.regenerate'` and `'bot.delete'` right after their `if (row.system !== null) throw new ProtocolError('FORBIDDEN');`:

```ts
  /**
   * The company's own Hermes (company_hermes.bot_id): whoever holds its connection code receives the
   * company's AI keys, so only the server's owner may make a new code or delete it.
   */
  const requireOwnerForCompanyHermes = (s: State, userId: string, botId: string): void => {
    if (s.ctx.db.get('SELECT 1 AS x FROM company_hermes WHERE bot_id = ?', botId) !== undefined && getMeta(s.ctx.db).ownerUserId !== userId) {
      throw new ProtocolError('FORBIDDEN');
    }
  };
```

```ts
      requireOwnerForCompanyHermes(s, ctx.userId, p.botId);
```

- [ ] **Step 12: Test helpers both server tracks use**

`apps/server/test/helpers/license.ts`:

```ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { formatLicense, type LicenseData } from '@ghostlink/shared';

/**
 * A license key made for this test run only (never a real one, never written anywhere): pass
 * `publicKey` to createEnterpriseModule and sign licenses with `issue`.
 */
export function testLicenseKey(): { publicKey: string; issue(d: Omit<LicenseData, 'v'>): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (typeof raw !== 'string') throw new Error('not an Ed25519 key');
  return { publicKey: raw, issue: (d) => formatLicense({ v: 1, ...d }, (input) => sign(null, input, privateKey)) };
}
```

`apps/server/test/helpers/enterprise.ts`:

```ts
import type { Edition } from '@ghostlink/shared';
import type { Db } from '../../src/db/database.js';
import { ENTERPRISE_MODULE_NAME, type EnterpriseModule } from '../../src/enterprise/index.js';

/**
 * An enterprise module whose edition the test sets (no license): for modules that only read the
 * edition. Writes `enterprise.edition` as the real module does, so the bot handshake sees it.
 */
export function fakeEnterprise(initial: Edition = 'enterprise'): EnterpriseModule & { set(edition: Edition): void } {
  let edition = initial;
  let db: Db | null = null;
  const listeners = new Set<(e: Edition) => void>();
  const write = () => db?.run("INSERT INTO enterprise (id, edition) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET edition = excluded.edition", edition);
  return {
    name: ENTERPRISE_MODULE_NAME,
    get edition() {
      return edition;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recheck() {},
    init(ctx) {
      db = ctx.db;
      write();
    },
    set(next) {
      if (next === edition) return;
      edition = next;
      write();
      for (const listener of [...listeners]) listener(next);
    },
  };
}
```

- [ ] **Step 13: The error strings the desktop must have (its typecheck demands one per code)**

`apps/desktop/src/renderer/i18n/enterprise.pt-BR.ts`:

```ts
// Enterprise and the company Hermes (v0.6.0, spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md).
// Spread into pt-BR.ts; enterprise.en.ts must have exactly the same keys.
export const enterprise = {
  'errors.ENTERPRISE_REQUIRED': 'Isso só funciona num servidor Enterprise.',
  'errors.LICENSE_INVALID': 'Essa licença não vale para este servidor.',
  'errors.LICENSE_EXPIRED': 'Essa licença já venceu.',
};
```

`apps/desktop/src/renderer/i18n/enterprise.en.ts`:

```ts
// Enterprise and the company Hermes (v0.6.0).
import type { enterprise as enterprisePt } from './enterprise.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const enterprise: Record<keyof typeof enterprisePt, string> = {
  'errors.ENTERPRISE_REQUIRED': 'This only works on an Enterprise server.',
  'errors.LICENSE_INVALID': 'That license is not valid for this server.',
  'errors.LICENSE_EXPIRED': 'That license has expired.',
};
```

Import them in `pt-BR.ts` / `en.ts` next to `bots` and spread `...enterprise,` right after `...bots,`.

- [ ] **Step 14: Keep key files out of the repository**

`.gitignore`, under `# local data and secrets`, add:

```
*.pem
```

- [ ] **Step 15: Check and commit**

Run: `npm run lint && npm run typecheck && npm test -- packages/shared/test/license.test.ts apps/server/test/bots.test.ts apps/server/test/database.test.ts`
Expected: PASS (the bots tests prove the `createBot` refactor changed nothing).

```bash
git add packages/shared/src/license.ts packages/shared/src/enterprise.ts packages/shared/src/companyHermes.ts packages/shared/src/errors.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/test/license.test.ts apps/server/src/db/migrations/009_enterprise.sql apps/server/src/enterprise/index.ts apps/server/src/companyHermes/index.ts apps/server/src/defaultModules.ts apps/server/src/bots/index.ts apps/server/test/helpers/license.ts apps/server/test/helpers/enterprise.ts apps/desktop/src/renderer/i18n/enterprise.pt-BR.ts apps/desktop/src/renderer/i18n/enterprise.en.ts apps/desktop/src/renderer/i18n/pt-BR.ts apps/desktop/src/renderer/i18n/en.ts .gitignore
git commit -m "feat(shared): the Enterprise license and the company Hermes protocol (contract)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track A: the license, the edition, the Ghost DJ hidden (server + scripts)

### Task A1: The license scripts

**Files:** Create `scripts/lib/license.mjs`, `scripts/gen-license-key.mjs`, `scripts/issue-license.mjs`, `scripts/test/license.test.ts`; Modify `scripts/tsconfig.json` (add `"gen-license-key.mjs", "issue-license.mjs"` to `include`).

- [ ] **Step 1: Write the failing test**

`scripts/test/license.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicense, ed25519SpkiDer, formatLicense, fromBase64Url } from '@ghostlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'scripts', script), ...args], { encoding: 'utf8' });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-license-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A key made by the script into a temp folder (deleted after the test), and its public half. */
function makeKey(): { file: string; publicKey: string } {
  const file = join(tempDir(), 'license-key.pem');
  const r = run('gen-license-key.mjs', ['--private-key-out', file]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE KEY/);
  return { file, publicKey: /^LICENSE_PUBLIC_KEY=([A-Za-z0-9_-]{43})$/m.exec(r.stdout)![1]! };
}

describe('gen-license-key.mjs', () => {
  it('writes the private key outside any repository, never prints it and never overwrites it', () => {
    const { file } = makeKey();
    expect(readFileSync(file, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = run('gen-license-key.mjs', ['--private-key-out', file]);
    expect(again.status).toBe(1);
    expect(again.stdout + again.stderr).not.toMatch(/PRIVATE KEY/);
  });

  it('refuses a path inside this repository or any git work tree, and runs only with --private-key-out', () => {
    const inside = join(repoRoot, 'license-key-never-created.pem');
    expect(run('gen-license-key.mjs', ['--private-key-out', inside]).status).toBe(2);
    expect(existsSync(inside)).toBe(false);
    const other = tempDir();
    mkdirSync(join(other, '.git'));
    expect(run('gen-license-key.mjs', ['--private-key-out', join(other, 'sub', 'k.pem')]).status).toBe(2);
    expect(run('gen-license-key.mjs', []).status).toBe(2);
  });
});

describe('issue-license.mjs', () => {
  const server = 'S'.repeat(43);

  it('issues a license the server accepts, byte for byte what @ghostlink/shared would sign', () => {
    const key = makeKey();
    const r = run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', server, '--until', '2099-12-31', '--expect-public-key', key.publicKey]);
    expect(r.status, r.stderr).toBe(0);
    const text = r.stdout.trim();
    const publicKey = createPublicKey({ key: Buffer.from(ed25519SpkiDer(fromBase64Url(key.publicKey))), format: 'der', type: 'spki' });
    const result = checkLicense(text, { serverKeyId: server, now: Date.now(), verify: (s, sig) => verify(null, s, publicKey, sig) });
    // 2099-12-31 23:59:59.999 in São Paulo (UTC−3).
    expect(result).toMatchObject({ state: 'valid', data: { company: 'TC Flag', serverKeyId: server, expiresAt: Date.UTC(2100, 0, 1, 2, 59, 59, 999) } });
    const privateKey = createPrivateKey(readFileSync(key.file, 'utf8'));
    expect(formatLicense(result.data!, (input) => sign(null, input, privateKey))).toBe(text);
  });

  it('refuses another key, a key inside a repository, a bad server identity and a past date', () => {
    const key = makeKey();
    const base = ['--company', 'TC Flag', '--server', server, '--until', '2099-12-31'];
    expect(run('issue-license.mjs', ['--key', key.file, ...base, '--expect-public-key', 'A'.repeat(43)]).status).toBe(1);
    expect(run('issue-license.mjs', ['--key', join(repoRoot, 'package.json'), ...base, '--expect-public-key', key.publicKey]).status).toBe(2);
    expect(run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', 'short', '--until', '2099-12-31', '--expect-public-key', key.publicKey]).status).toBe(2);
    expect(run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', server, '--until', '2001-01-01', '--expect-public-key', key.publicKey]).status).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- scripts/test/license.test.ts`
Expected: FAIL — the scripts do not exist.

- [ ] **Step 3: Write `scripts/lib/license.mjs`**

```js
// Enterprise license helpers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1) for
// gen-license-key.mjs and issue-license.mjs. Node built-ins only. The format mirrors
// packages/shared/src/license.ts byte for byte (scripts/test/license.test.ts checks it).
import { Buffer } from 'node:buffer';
import { sign } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const LICENSE_PREFIX = 'GLE1';
export const LICENSE_LABEL = 'ghostlink-license-v1';

/**
 * `GLE1.<data>.<signature>`, as formatLicense in @ghostlink/shared.
 * @param {{ company: string; serverKeyId: string; issuedAt: number; expiresAt: number }} d
 * @param {import('node:crypto').KeyObject} privateKey an Ed25519 private key
 */
export function encodeLicense(d, privateKey) {
  const json = JSON.stringify({ v: 1, company: d.company, serverKeyId: d.serverKeyId, issuedAt: d.issuedAt, expiresAt: d.expiresAt });
  const segment = Buffer.from(json, 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(`${LICENSE_LABEL}\n${segment}`, 'utf8'), privateKey);
  return `${LICENSE_PREFIX}.${segment}.${signature.toString('base64url')}`;
}

/**
 * The git work tree that holds `path` (the nearest existing folder or a parent with a `.git` entry),
 * or null. A private key is never written there nor read from there.
 * @param {string} path a file path (it need not exist)
 */
export function enclosingWorkTree(path) {
  let dir = resolve(dirname(path));
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  dir = realpathSync.native(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The last millisecond of `YYYY-MM-DD` in São Paulo (UTC−3, no daylight saving since 2019).
 * @param {string} date
 */
export function endOfDaySaoPaulo(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('the date must be YYYY-MM-DD');
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 2, 59, 59, 999);
  if (new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10) !== date) throw new Error('not a real date');
  return ms;
}

/**
 * LICENSE_PUBLIC_KEY as written in packages/shared/src/license.ts.
 * @param {string} repoRoot
 */
export function embeddedLicensePublicKey(repoRoot) {
  const source = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'license.ts'), 'utf8');
  const key = /export const LICENSE_PUBLIC_KEY: string = '([A-Za-z0-9_-]{43})';/.exec(source)?.[1];
  if (key === undefined) throw new Error('LICENSE_PUBLIC_KEY is not set in packages/shared/src/license.ts (run gen-license-key.mjs first)');
  return key;
}
```

- [ ] **Step 4: Write `scripts/gen-license-key.mjs`**

```js
// Makes the Enterprise LICENSE key (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): a
// new Ed25519 key, separate from the release key. Run once, on the owner's PC:
//
//   node scripts/gen-license-key.mjs --private-key-out "D:\GhostLink Licencas\ghostlink-license-key.pem"
//
// It prints only LICENSE_PUBLIC_KEY=<raw base64url> (for packages/shared/src/license.ts). The private
// key goes only to --private-key-out (created 0600, never overwritten), which must be outside every
// git work tree. It is never printed. The owner keeps a backup copy wherever they choose.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { enclosingWorkTree } from './lib/license.mjs';
import { generateReleaseKey } from './lib/releaseKey.mjs';

/** @param {string[]} argv */
function main(argv) {
  const index = argv.indexOf('--private-key-out');
  const out = index >= 0 ? argv[index + 1] : undefined;
  if (out === undefined || out.startsWith('--')) {
    console.error('usage: node scripts/gen-license-key.mjs --private-key-out <file outside any git repository>');
    return 2;
  }
  const tree = enclosingWorkTree(out);
  if (tree !== null) {
    console.error(`refusing: ${out} is inside the git work tree ${tree}. The license private key never goes near a repository.`);
    return 2;
  }
  // An Ed25519 keypair, the same helper as the release key (a new, separate key).
  const { publicKey, privateKeyPem } = generateReleaseKey();
  try {
    writeFileSync(out, privateKeyPem, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    console.error(code === 'EEXIST' ? `${out} already exists; refusing to overwrite it.` : `cannot write ${out} (${code ?? 'error'}).`);
    return 1;
  }
  console.log(`LICENSE_PUBLIC_KEY=${publicKey}`);
  console.log(`Private key written to ${out}. Keep a backup copy somewhere safe; it never goes into the repository.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
```

- [ ] **Step 5: Write `scripts/issue-license.mjs`**

```js
// Issues an Enterprise license (spec §1), on the owner's PC, with Claude:
//
//   node scripts/issue-license.mjs --key "D:\GhostLink Licencas\ghostlink-license-key.pem" \
//     --company "TC Flag" --server <serverKeyId> --until 2027-10-02
//
// <serverKeyId>: Configurações do servidor → Enterprise → "Identidade do servidor". --until: the last
// day it is valid (São Paulo time). Prints the license (GLE1.…) for the owner to paste in that tab.
// Refuses a key file inside a git work tree and a key that is not LICENSE_PUBLIC_KEY's
// (--expect-public-key overrides the expected key: tests only).
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { embeddedLicensePublicKey, enclosingWorkTree, encodeLicense, endOfDaySaoPaulo } from './lib/license.mjs';
import { rawPublicKey } from './lib/releaseKey.mjs';

/**
 * @param {string[]} argv
 * @param {string} name
 */
function arg(argv, name) {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** @param {string[]} argv */
function main(argv) {
  const keyPath = arg(argv, '--key');
  const company = arg(argv, '--company')?.trim();
  const server = arg(argv, '--server');
  const until = arg(argv, '--until');
  if (!keyPath || !company || !server || !until) {
    console.error('usage: node scripts/issue-license.mjs --key <license key .pem> --company <name> --server <serverKeyId> --until YYYY-MM-DD');
    return 2;
  }
  if (company.length > 100) {
    console.error('--company: at most 100 characters');
    return 2;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(server)) {
    console.error('--server: the server identity (43 characters, Configurações do servidor → Enterprise)');
    return 2;
  }
  if (enclosingWorkTree(keyPath) !== null) {
    console.error('refusing: the key file is inside a git work tree');
    return 2;
  }
  let expiresAt;
  try {
    expiresAt = endOfDaySaoPaulo(until);
  } catch (e) {
    console.error(`--until: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  const now = Date.now();
  if (expiresAt <= now) {
    console.error('--until is in the past');
    return 2;
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: readFileSync(keyPath, 'utf8'), format: 'pem' });
  } catch {
    console.error('cannot read the license key (a PEM private key)');
    return 1;
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    console.error('the license key must be an Ed25519 key');
    return 1;
  }
  let expected;
  try {
    expected = arg(argv, '--expect-public-key') ?? embeddedLicensePublicKey(fileURLToPath(new URL('..', import.meta.url)));
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    return 1;
  }
  if (rawPublicKey(privateKey) !== expected) {
    console.error('this key is not the one in LICENSE_PUBLIC_KEY (packages/shared/src/license.ts)');
    return 1;
  }
  console.log(encodeLicense({ company, serverKeyId: server, issuedAt: now, expiresAt }, privateKey));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
```

- [ ] **Step 6: Run the test**

Run: `npm test -- scripts/test/license.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/license.mjs scripts/gen-license-key.mjs scripts/issue-license.mjs scripts/test/license.test.ts scripts/tsconfig.json
git commit -m "feat(scripts): the Enterprise license key and license issuing, on the owner's PC only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8 (CHECKPOINT, main session with the owner, any time before the release): the key ceremony**

On the owner's PC (not in CI, not in a subagent), with the owner watching:

```bash
node scripts/gen-license-key.mjs --private-key-out "D:\GhostLink Licencas\ghostlink-license-key.pem"
```

Copy only the printed `LICENSE_PUBLIC_KEY=` value into `packages/shared/src/license.ts` (`export const LICENSE_PUBLIC_KEY: string = '<value>';`), add to `packages/shared/test/license.test.ts`:

```ts
it('the license public key is set (the ceremony ran)', () => {
  expect(LICENSE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
```

(import `LICENSE_PUBLIC_KEY`), and commit `feat(shared): the Enterprise license public key`. Ask the owner to copy the `.pem` to a backup place of their choice. Never open, print or paste the `.pem`.

### Task A2: The enterprise module

**Files:** Modify `apps/server/src/enterprise/index.ts`; Create `apps/server/test/enterprise.test.ts`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/enterprise.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FEATURE_ENTERPRISE, type EnterpriseState } from '@ghostlink/shared';
import { createEnterpriseModule } from '../src/enterprise/index.js';
import { withDb } from './helpers/db.js';
import { testLicenseKey } from './helpers/license.js';
import { textFixture } from './text/helpers.js';

const DAY = 86_400_000;

async function setup() {
  const key = testLicenseKey();
  const enterprise = createEnterpriseModule({ publicKey: key.publicKey });
  const fx = await textFixture({ extraModules: [enterprise] });
  const serverKeyId = fx.t.server.serverKeyId;
  const license = (o: { days?: number; serverKeyId?: string; issuedDaysAgo?: number } = {}) =>
    key.issue({
      company: 'TC Flag',
      serverKeyId: o.serverKeyId ?? serverKeyId,
      issuedAt: fx.clock.now - (o.issuedDaysAgo ?? 0) * DAY,
      expiresAt: fx.clock.now + (o.days ?? 365) * DAY,
    });
  return { fx, enterprise, license };
}

describe('Enterprise: the license and the edition (spec §1)', () => {
  it('a valid license makes the server Enterprise for everyone; only the owner sees the license', async () => {
    const { fx, license } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    expect((fx.owner.welcome as { features: string[] }).features).toContain(FEATURE_ENTERPRISE);
    expect(fx.owner.welcome.enterprise).toEqual({ edition: 'normal', license: null });
    expect(ana.welcome.enterprise).toEqual({ edition: 'normal' });

    expect(await ana.fail('enterprise.license.set', { license: license() })).toBe('FORBIDDEN');
    const state = await fx.owner.ok<EnterpriseState>('enterprise.license.set', { license: license() });
    expect(state).toMatchObject({ edition: 'enterprise', license: { state: 'valid', company: 'TC Flag' } });
    expect(await ana.event<EnterpriseState>('enterprise.state')).toEqual({ edition: 'enterprise' });
    // The bot handshake reads the edition from the database.
    expect(withDb(fx.t.dataDir, (db) => db.get<{ edition: string }>('SELECT edition FROM enterprise WHERE id = 1')?.edition)).toBe('enterprise');
  });

  it('refuses a broken, forged or other-server license, and one past its grace', async () => {
    const { fx, license } = await setup();
    expect(await fx.owner.fail('enterprise.license.set', { license: 'GLE1.abc.def' })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: testLicenseKey().issue({ company: 'X', serverKeyId: fx.t.server.serverKeyId, issuedAt: 0, expiresAt: fx.clock.now + DAY }) })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: license({ serverKeyId: 'T'.repeat(43) }) })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: license({ issuedDaysAgo: 400, days: -8 }) })).toBe('LICENSE_EXPIRED');
    expect(fx.owner.seen('enterprise.state')).toEqual([]);
  });

  it('warns 7 days before, stays Enterprise 7 days after, then is normal; a renewal counts at once', async () => {
    const { fx, enterprise, license } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    await fx.owner.ok('enterprise.license.set', { license: license({ days: 10 }) });
    await ana.event('enterprise.state');
    ana.clear();
    fx.owner.clear();

    fx.clock.now += 4 * DAY;
    enterprise.recheck();
    expect(await fx.owner.event<EnterpriseState>('enterprise.state')).toMatchObject({ edition: 'enterprise', license: { state: 'expiring' } });
    fx.clock.now += 7 * DAY;
    enterprise.recheck();
    expect(await fx.owner.event<EnterpriseState>('enterprise.state', (d) => d.license?.state === 'grace')).toMatchObject({ edition: 'enterprise' });
    await ana.sync();
    expect(ana.seen('enterprise.state')).toEqual([]);

    fx.clock.now += 7 * DAY;
    enterprise.recheck();
    expect(await ana.event<EnterpriseState>('enterprise.state')).toEqual({ edition: 'normal' });
    expect(enterprise.edition).toBe('normal');

    const renewed = await fx.owner.ok<EnterpriseState>('enterprise.license.set', { license: license({ days: 365 }) });
    expect(renewed).toMatchObject({ edition: 'enterprise', license: { state: 'valid' } });
    expect(await ana.event<EnterpriseState>('enterprise.state', (d) => d.edition === 'enterprise')).toEqual({ edition: 'enterprise' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/server/test/enterprise.test.ts`
Expected: FAIL — the stub has no handler, no welcome key, no feature.

- [ ] **Step 3: Implement the module** (replace the stub's `createEnterpriseModule`; keep the contract's exports and merge these imports with the file's own)

```ts
import {
  ENTERPRISE_LIMITS,
  FEATURE_ENTERPRISE,
  LICENSE_LIMITS,
  LICENSE_PUBLIC_KEY,
  ProtocolError,
  checkLicense,
  enterpriseLicenseSetSchema,
  fromBase64Url,
  grantsEnterprise,
  type Edition,
  type EnterpriseLicenseInfo,
  type EnterpriseState,
  type LicenseCheck,
} from '@ghostlink/shared';
import { verifyAuthSignature } from '../auth/identity.js';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';

const CHECK_EVERY_MS = 3_600_000;

/** The raw 32-byte key, or null ('' before the key ceremony: every license is then invalid). */
function rawKey(b64u: string): Uint8Array | null {
  try {
    const raw = fromBase64Url(b64u);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

export function createEnterpriseModule(opts: EnterpriseModuleOptions = {}): EnterpriseModule {
  const publicKey = rawKey(opts.publicKey ?? LICENSE_PUBLIC_KEY);
  const listeners = new Set<(edition: Edition) => void>();
  let ctx: ModuleContext | null = null;
  let limiter: SlidingWindowLimiter | null = null;
  let timer: NodeJS.Timeout | null = null;
  let edition: Edition = 'normal';
  let license: EnterpriseLicenseInfo | null = null;
  let lastOwner: string | null = null;

  const need = (): ModuleContext => {
    if (!ctx) throw new Error('the enterprise module is not initialized');
    return ctx;
  };
  const ownerId = (c: ModuleContext): string | null => getMeta(c.db).ownerUserId;

  const check = (c: ModuleContext, text: string): LicenseCheck =>
    checkLicense(text, {
      serverKeyId: c.serverKeyId,
      now: c.now(),
      verify: (signed, signature) => publicKey !== null && verifyAuthSignature(publicKey, signed, signature),
    });

  const infoOf = (r: LicenseCheck): EnterpriseLicenseInfo => ({
    state: r.state,
    company: r.data?.company ?? null,
    issuedAt: r.data?.issuedAt ?? null,
    expiresAt: r.data?.expiresAt ?? null,
    graceEndsAt: r.data ? r.data.expiresAt + LICENSE_LIMITS.graceMs : null,
  });

  const stateFor = (c: ModuleContext, userId: string): EnterpriseState => (userId === ownerId(c) ? { edition, license } : { edition });

  const sendToOwner = (c: ModuleContext): void => {
    const owner = ownerId(c);
    for (const s of c.sessions.list()) if (s.userId === owner) c.sessions.send(s.sessionId, { t: 'enterprise.state', d: stateFor(c, s.userId) });
  };

  /** Evaluates the stored license; mirrors the edition for the bot handshake; tells whoever must know. */
  const recheck = (): void => {
    const c = ctx;
    if (!c) return;
    const text = c.db.get<{ license: string | null }>('SELECT license FROM enterprise WHERE id = 1')?.license ?? null;
    const result = text === null ? null : check(c, text);
    const nextLicense = result ? infoOf(result) : null;
    const nextEdition: Edition = result !== null && grantsEnterprise(result.state) ? 'enterprise' : 'normal';
    const editionChanged = nextEdition !== edition;
    const licenseChanged = JSON.stringify(nextLicense) !== JSON.stringify(license);
    edition = nextEdition;
    license = nextLicense;
    // auth/botAuth.ts reads it: the company Hermes is refused at a normal server's door.
    c.db.run("INSERT INTO enterprise (id, edition) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET edition = excluded.edition", edition);
    if (editionChanged) {
      c.logger.info('server edition changed', { edition });
      for (const s of c.sessions.list()) c.sessions.send(s.sessionId, { t: 'enterprise.state', d: stateFor(c, s.userId) });
      for (const listener of [...listeners]) {
        try {
          listener(edition);
        } catch (e) {
          c.logger.error('an edition listener failed', { error: String(e) });
        }
      }
    } else if (licenseChanged) {
      sendToOwner(c);
    }
  };

  const module: EnterpriseModule = {
    name: ENTERPRISE_MODULE_NAME,
    features: [FEATURE_ENTERPRISE],
    get edition() {
      return edition;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recheck,

    handlers: {
      'enterprise.license.set': (rc, payload): EnterpriseState => {
        const p = enterpriseLicenseSetSchema.parse(payload);
        const c = need();
        if (rc.userId !== ownerId(c)) throw new ProtocolError('FORBIDDEN');
        if (!limiter!.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
        const text = p.license.trim();
        const result = check(c, text);
        if (result.state === 'expired') throw new ProtocolError('LICENSE_EXPIRED');
        if (!grantsEnterprise(result.state)) throw new ProtocolError('LICENSE_INVALID');
        c.db.run(
          `INSERT INTO enterprise (id, license, set_by, set_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET license = excluded.license, set_by = excluded.set_by, set_at = excluded.set_at`,
          text,
          rc.userId,
          c.now(),
        );
        recheck();
        return stateFor(c, rc.userId);
      },
    },

    init(c) {
      ctx = c;
      limiter = new SlidingWindowLimiter(ENTERPRISE_LIMITS.licenseSetsPerMinute, 60_000, c.now);
      recheck();
      lastOwner = ownerId(c);
      try {
        // An ownership transfer: the new owner's open sessions learn the license.
        c.getModule<TextModule>(TEXT_MODULE_NAME).events.on('access.changed', () => {
          const owner = ownerId(c);
          if (owner === lastOwner) return;
          lastOwner = owner;
          sendToOwner(c);
        });
      } catch {
        // no text module (a unit test): nothing to follow
      }
    },

    start() {
      timer = setInterval(() => {
        recheck();
        limiter?.sweep();
      }, opts.checkEveryMs ?? CHECK_EVERY_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    welcome: (session) => ({ enterprise: stateFor(need(), session.userId) }),
  };
  return module;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- apps/server/test/enterprise.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/enterprise/index.ts apps/server/test/enterprise.test.ts
git commit -m "feat(server): Enterprise licenses and the server's edition

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A3: The Ghost DJ hides in an Enterprise server

**Files:** Modify `apps/server/src/text/bots.ts`, `apps/server/src/bots/index.ts`, `apps/server/src/ghostDj/dj.ts`, `apps/server/src/ghostDj/index.ts`, `apps/server/test/ghostDj.test.ts`.

- [ ] **Step 1: Write the failing test**

In `apps/server/test/ghostDj.test.ts`:

1. Let `setup` take an enterprise module and register it before the DJ:

```ts
async function setup(o: { ffmpeg?: string | null; enterprise?: EnterpriseModule } = {}): Promise<Dj> {
```

```ts
    extraModules: [
      createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 }),
      createAvatarsModule(),
      createBotsModule(),
      ...(o.enterprise ? [o.enterprise] : []),
      module,
    ],
```

2. Add (imports: `createEnterpriseModule, type EnterpriseModule` from `../src/enterprise/index.js`, `testLicenseKey` from `./helpers/license.js`, `withDb` from `./helpers/db.js`, `type BotCommands` from `@ghostlink/shared`):

```ts
describe('Ghost DJ in an Enterprise server (spec 2026-10-02-enterprise-e-hermes-da-empresa §1)', () => {
  it('stops, leaves and disappears while the server is Enterprise; comes back when it is normal again', async () => {
    const key = testLicenseKey();
    const enterprise = createEnterpriseModule({ publicKey: key.publicKey });
    const d = await setup({ enterprise });
    const DAY = 86_400_000;
    await enterVoice(d, d.fx.owner, d.sala);
    await use(d, d.fx.owner, 'play', [{ name: 'busca', value: 'musica' }]);
    await expect.poll(() => d.outputs.length).toBe(1);
    await d.fx.owner.ok('dj.eq', { preset: 'rock' });

    await d.fx.owner.ok('enterprise.license.set', {
      license: key.issue({ company: 'TC Flag', serverKeyId: d.fx.t.server.serverKeyId, issuedAt: d.fx.clock.now, expiresAt: d.fx.clock.now + DAY }),
    });
    await d.fx.owner.event('member.left', (e: { userId: string }) => e.userId === d.djId);
    await d.fx.owner.event<BotCommands>('commands.updated', (e) => e.botId === d.djId && e.commands.length === 0);
    await expect.poll(() => d.outputs[0]!.closed).toBe(true);
    expect(d.module.dj!.channelId).toBeNull();
    expect((await d.fx.join({ nickname: 'Bia' })).text.members.some((m) => m.userId === d.djId)).toBe(false);
    d.fx.clock.now += 1_000;
    expect(await d.fx.owner.fail('interaction.invoke', { channelId: d.geral, botId: d.djId, command: 'play', options: [{ name: 'busca', value: 'x' }] })).toBe('NOT_FOUND');
    expect(await d.fx.owner.fail('dj.state', {})).toBe('NOT_FOUND');

    d.fx.clock.now += 9 * DAY; // past the expiry and its 7 days of grace
    enterprise.recheck();
    await d.fx.owner.event('member.joined', (e: { member: { userId: string } }) => e.member.userId === d.djId);
    await d.fx.owner.event<BotCommands>('commands.updated', (e) => e.botId === d.djId && e.commands.length > 0);
    expect((await d.fx.owner.ok<GhostDjState>('dj.state', {})).eq.preset).toBe('rock');
    expect(withDb(d.fx.t.dataDir, (db) => db.get<{ removed_at: number | null }>('SELECT removed_at FROM users WHERE id = ?', d.djId)?.removed_at)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/server/test/ghostDj.test.ts -t "Enterprise"`
Expected: FAIL — the DJ never leaves the member list.

- [ ] **Step 3: `park` / `unpark` in the text module's bot API**

`apps/server/src/text/bots.ts`, add to `BotTextApi`:

```ts
  /**
   * Takes a system bot out of the member list while it must not exist (the Ghost DJ in an
   * Enterprise server): like a removal (member.left, offline, voice ends), but its roles stay for
   * its return. Nothing when it is not a member.
   */
  park(userId: string): void;
  /** Brings a parked bot back: member.joined, online. */
  unpark(userId: string): void;
```

and to `createBotTextApi`'s object:

```ts
    park: (userId) => {
      const core = need();
      if (!core.repo.isMember(userId)) return;
      core.db.run('UPDATE users SET removed_at = ? WHERE id = ? AND removed_at IS NULL', core.now(), userId);
      core.online.delete(userId);
      finishRemoval(core, userId, 'left', null);
    },

    unpark: (userId) => {
      const core = need();
      core.db.run('UPDATE users SET removed_at = NULL, rejoin_blocked_until = NULL WHERE id = ?', userId);
      const member = core.repo.member(userId, true);
      if (!member) return;
      core.knownMembers.add(userId);
      core.online.add(userId);
      core.broadcastAll({ t: 'member.joined', d: { member } }, userId);
    },
```

- [ ] **Step 4: `hidden` and `setHidden` for system bots**

`apps/server/src/bots/index.ts`:

```ts
// SystemBotSpec:
  /** Starts hidden (an Enterprise server has no Ghost DJ: spec 2026-10-02-enterprise §1). */
  hidden?: boolean;

// SystemBot:
  /**
   * Hidden: it leaves the member list (member.left), its commands go (commands.updated with none),
   * its roles stay. Shown: member.joined and its commands again (not while banned). Idempotent.
   */
  setHidden(hidden: boolean): void;
```

In `ensureSystemBot`:
- the "a kick took it out" branch becomes `} else if (!spec.hidden && !s.text.isMember(botId) && !banned(botId)) {` with `const banned = (id: string) => db.get('SELECT 1 AS x FROM bans WHERE user_id = ?', id) !== undefined;`;
- replace the tail (from `db.run('UPDATE bots SET commands = ?…` to `if (s.text.isMember(id)) s.text.setOnline(id, true);`) with:

```ts
    const storeCommands = (list: BotCommand[]) => db.run('UPDATE bots SET commands = ? WHERE user_id = ?', JSON.stringify(list), id);
    let hidden = spec.hidden === true;
    storeCommands(hidden ? [] : commands);
    s.interactions.setLocalHandler(id, spec.onInteraction);
    if (hidden) s.text.park(id);
    else if (s.text.isMember(id)) s.text.setOnline(id, true);
```

- add to the returned object:

```ts
      setHidden: (next) => {
        if (next === hidden) return;
        if (!next && banned(id)) return;
        hidden = next;
        if (next) {
          s.text.park(id);
          storeCommands([]);
          s.text.broadcastMembers({ t: 'commands.updated', d: { botId: id, commands: [] } satisfies BotCommands });
        } else {
          storeCommands(commands);
          s.text.unpark(id);
          s.text.broadcastMembers({ t: 'commands.updated', d: { botId: id, commands } satisfies BotCommands });
        }
      },
```

- [ ] **Step 5: `leave()` in the DJ engine**

`apps/server/src/ghostDj/dj.ts`, after `shutdown()`:

```ts
  /** Stops and leaves its voice channel, as /stop does (the server became Enterprise). */
  async leave(): Promise<void> {
    await this.#opening?.catch(() => undefined);
    if (this.#session) await this.#end(this.#session, 'stop');
  }
```

- [ ] **Step 6: The module hides while the server is Enterprise**

`apps/server/src/ghostDj/index.ts`:

1. `import { ProtocolError } from '@ghostlink/shared';` (with the other shared imports), `import { enterpriseOf } from '../enterprise/index.js';` and `import type { RequestHandler } from '../modules.js';`.
2. State: `let hidden = false;` and `let systemBot: SystemBot | null = null;` (import the `SystemBot` type from `../bots/index.js`).
3. Wrap every handler, v0.5.2's cookies handlers included, so a hidden DJ answers nothing:

```ts
/** While the server is Enterprise the DJ does not exist: its requests answer NOT_FOUND (its data stays). */
function unlessHidden(isHidden: () => boolean, handlers: Record<string, RequestHandler>): Record<string, RequestHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([type, handler]): [string, RequestHandler] => [
      type,
      (rc, payload) => {
        if (isHidden()) throw new ProtocolError('NOT_FOUND');
        return handler(rc, payload);
      },
    ]),
  );
}
```

and use `handlers: unlessHidden(() => hidden, { 'dj.state': …, 'dj.eq': …, … }),`.
4. `features`: `if (hidden) return [];` as the getter's first line.
5. In `init`, before `ensureSystemBot`: `const enterprise = enterpriseOf(c); hidden = enterprise?.edition === 'enterprise';` — pass `hidden` in the spec, keep `systemBot = bot`, and `onInteraction: (e) => { if (!hidden) dj?.handle(e); }`. After `dj = new GhostDj(...)`:

```ts
      enterprise?.onChange((edition) => void setEnterprise(edition === 'enterprise'));
```

with, inside the factory:

```ts
  /** Enterprise: stop, leave the call, then leave the member list (spec 2026-10-02-enterprise §1). */
  const setEnterprise = async (on: boolean): Promise<void> => {
    if (on === hidden) return;
    hidden = on;
    if (on) {
      await dj?.leave().catch((e: unknown) => ctx?.logger.warn('Ghost DJ: could not leave', { error: e instanceof Error ? e.message : String(e) }));
      systemBot?.setHidden(true);
    } else {
      systemBot?.setHidden(false);
    }
  };
```

- [ ] **Step 7: Run the DJ tests**

Run: `npm test -- apps/server/test/ghostDj.test.ts apps/server/test/bots.test.ts`
Expected: PASS (the new test, and nothing else changed).

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/server/src/text/bots.ts apps/server/src/bots/index.ts apps/server/src/ghostDj/dj.ts apps/server/src/ghostDj/index.ts apps/server/test/ghostDj.test.ts
git commit -m "feat(server): the Ghost DJ leaves Enterprise servers and comes back when they are normal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track B: the company Hermes on the server

### Task B1: The store, the requests, the events

**Files:** Create `apps/server/src/companyHermes/store.ts`; Modify `apps/server/src/companyHermes/index.ts`; Create `apps/server/test/companyHermes.test.ts`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/companyHermes.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PROTOCOL,
  parseBotConnectionCode,
  type BotCreateResult,
  type Edition,
  type ErrorCode,
  type HermesConfig,
  type HermesReport,
  type HermesState,
} from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule } from '../src/bots/index.js';
import { createCompanyHermesModule } from '../src/companyHermes/index.js';
import { fakeEnterprise } from './helpers/enterprise.js';
import { connectRaw } from './helpers/testClient.js';
import { textFixture, wrapClient, type TextClient, type TextFixture } from './text/helpers.js';

/** Obviously fake, made at run time: never a real key. */
const fakeKey = (tag: string) => `sk-test-${tag}-${randomBytes(12).toString('hex')}`;

async function setup(edition: Edition = 'enterprise') {
  const enterprise = fakeEnterprise(edition);
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule(), enterprise, createCompanyHermesModule()] });
  return { fx, enterprise };
}

/** The bot handshake (as in bots.test.ts). */
async function connectBot(fx: TextFixture, code: string): Promise<{ client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode }> {
  const parsed = parseBotConnectionCode(code)!;
  const raw = await connectRaw(fx.t.server, { pin: parsed.serverKeyId });
  raw.send({ t: 'hello', d: { protocol: PROTOCOL.current, bot: parsed.token, client: 'hermes-test/0.0.0' } });
  const m = await raw.next();
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  const welcome = m.d as { self: { userId: string; nickname: string } } & Record<string, unknown>;
  return { client: wrapClient(raw, welcome, { userId: welcome.self.userId, seed: new Uint8Array(32), nickname: welcome.self.nickname }) };
}

async function admin(fx: TextFixture): Promise<TextClient> {
  const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Gerente', permissions: PERMISSIONS.MANAGE_SERVER });
  const ana = await fx.join({ nickname: 'Ana' });
  await fx.owner.ok('member.setRoles', { userId: ana.userId, roleIds: [role.id] });
  return ana;
}

const report = (o: Partial<HermesReport> = {}): HermesReport => ({
  appliedVersion: 1,
  skills: [{ name: 'resumo', description: 'Resume conversas', enabled: true, locked: false }],
  memory: { company: [{ id: '0123456789abcdef', text: 'A TC Flag fabrica bandeiras.' }], people: [] },
  status: { model: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null, keys: { deepseek: 'ok', openrouter: 'missing' }, unsupported: null, envOverride: [] },
  ...o,
});

describe('the company Hermes (spec §2)', () => {
  it('only the owner of an Enterprise server creates it, once', async () => {
    const { fx } = await setup();
    const ana = await admin(fx);
    expect(await ana.fail('hermes.create', { name: 'TC Hermes' })).toBe('FORBIDDEN');
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    expect(created.connectionToken).toMatch(/^ghostlink-bot:\/\//);
    expect(await fx.owner.fail('hermes.create', { name: 'Outro' })).toBe('BAD_REQUEST');
    expect((await fx.owner.event<HermesState>('hermes.state')).botId).toBe(created.bot.userId);
    // Whoever holds its code gets the keys: only the owner makes a new one or deletes it.
    expect(await ana.fail('bot.regenerate', { botId: created.bot.userId })).toBe('FORBIDDEN');
    expect(await ana.fail('bot.delete', { botId: created.bot.userId })).toBe('FORBIDDEN');

    const normal = await setup('normal');
    expect(await normal.fx.owner.fail('hermes.create', { name: 'TC Hermes' })).toBe('ENTERPRISE_REQUIRED');
  });

  it('keys go only to the company Hermes, never back to an app', async () => {
    const { fx } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    expect((await hermes.event<HermesConfig>('hermes.config')).version).toBe(0);

    const key = fakeKey('deepseek');
    const state = await fx.owner.ok<HermesState>('hermes.update', { keys: { deepseek: `  ${key} ` } });
    expect(state.keys).toEqual({ deepseek: { last4: key.slice(-4) }, openrouter: null });
    const config = await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 1);
    expect(config.keys.deepseek).toBe(key);
    expect(config.models.primary).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });

    await Promise.all([impostor.sync(), ana.sync(), fx.owner.sync()]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    expect(ana.seen('hermes.state')).toEqual([]);
    for (const seen of [JSON.stringify(state), JSON.stringify(fx.owner.events), JSON.stringify(ana.events), JSON.stringify(await fx.owner.ok('hermes.get', {}))]) {
      expect(seen).not.toContain(key);
    }
    expect(await impostor.fail('hermes.report', report())).toBe('FORBIDDEN');
  });

  it('reports reach the owner live; memory deletes reach the Hermes; offline answers BOT_OFFLINE', async () => {
    const { fx } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    expect(await fx.owner.fail('hermes.memory.delete', { target: 'company', id: '0123456789abcdef' })).toBe('BOT_OFFLINE');
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.ok('hermes.report', report());
    const state = await fx.owner.event<HermesState>('hermes.state', (s) => s.report !== null);
    expect(state).toMatchObject({ connected: true, report: { skills: [{ name: 'resumo' }] } });
    await fx.owner.ok('hermes.memory.delete', { target: 'company', id: '0123456789abcdef' });
    expect(await hermes.event('hermes.memory.delete')).toEqual({ target: 'company', id: '0123456789abcdef' });
    // Disconnected: the last report stays, with the warning in the app.
    hermes.close();
    await fx.owner.event<HermesState>('hermes.state', (s) => !s.connected);
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).report?.skills[0]?.name).toBe('resumo');
  });

  it('a lapsed license disconnects it, refuses it at the door and locks its settings', async () => {
    const { fx, enterprise } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.event('hermes.config');
    enterprise.set('normal');
    await hermes.closed;
    expect(hermes.closedWith).toBe('ENTERPRISE_REQUIRED');
    expect((await connectBot(fx, created.connectionToken)).error).toBe('ENTERPRISE_REQUIRED');
    expect(await fx.owner.fail('hermes.update', { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-flash' }, fallback: null } })).toBe('ENTERPRISE_REQUIRED');
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).locked).toBe(true);
    enterprise.set('enterprise');
    expect((await connectBot(fx, created.connectionToken)).client).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/server/test/companyHermes.test.ts`
Expected: FAIL — `hermes.create` is an unknown request.

- [ ] **Step 3: Write `apps/server/src/companyHermes/store.ts`**

```ts
import {
  HERMES_DEFAULT_SETTINGS,
  HERMES_PROVIDERS,
  hermesReportSchema,
  hermesSettingsSchema,
  type HermesProvider,
  type HermesReport,
  type HermesSettings,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';

interface Row {
  bot_id: string | null;
  deepseek_key: string | null;
  openrouter_key: string | null;
  settings: string;
  version: number;
  report: string | null;
  report_at: number | null;
}

export interface HermesRecord {
  botId: string | null;
  /** Secrets: only for hermes.config, never for an answer or a log. */
  keys: Record<HermesProvider, string | null>;
  settings: HermesSettings;
  version: number;
  report: HermesReport | null;
  reportAt: number | null;
}

function json(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The single company_hermes row (009_enterprise.sql), read fresh each time. */
export class HermesStore {
  constructor(private readonly db: Db) {
    db.run('INSERT OR IGNORE INTO company_hermes (id) VALUES (1)');
  }

  load(): HermesRecord {
    const r = this.db.get<Row>('SELECT bot_id, deepseek_key, openrouter_key, settings, version, report, report_at FROM company_hermes WHERE id = 1')!;
    const settings = hermesSettingsSchema.safeParse(json(r.settings));
    const report = hermesReportSchema.safeParse(json(r.report));
    return {
      botId: r.bot_id,
      keys: { deepseek: r.deepseek_key, openrouter: r.openrouter_key },
      settings: settings.success ? settings.data : HERMES_DEFAULT_SETTINGS,
      version: Number(r.version),
      report: report.success ? report.data : null,
      reportAt: r.report_at === null ? null : Number(r.report_at),
    };
  }

  setBot(botId: string): void {
    this.db.run('UPDATE company_hermes SET bot_id = ? WHERE id = 1', botId);
  }

  /** Merges a change and bumps the version. */
  update(p: HermesUpdatePayload): void {
    const current = this.load();
    const keys = { ...current.keys };
    for (const provider of HERMES_PROVIDERS) {
      const value = p.keys?.[provider];
      if (value !== undefined) keys[provider] = value;
    }
    const settings: HermesSettings = {
      models: p.models ?? current.settings.models,
      disabledSkills: p.disabledSkills ?? current.settings.disabledSkills,
      access: p.access ?? current.settings.access,
    };
    this.db.run(
      'UPDATE company_hermes SET deepseek_key = ?, openrouter_key = ?, settings = ?, version = version + 1 WHERE id = 1',
      keys.deepseek,
      keys.openrouter,
      JSON.stringify(settings),
    );
  }

  saveReport(report: HermesReport, at: number): void {
    this.db.run('UPDATE company_hermes SET report = ?, report_at = ? WHERE id = 1', JSON.stringify(report), at);
  }
}
```

- [ ] **Step 4: Implement the module** (`apps/server/src/companyHermes/index.ts`, keeping the contract's exports)

```ts
import {
  FEATURE_ENTERPRISE_HERMES,
  HERMES_LIMITS,
  ProtocolError,
  hermesCreateSchema,
  hermesGetSchema,
  hermesMemoryDeleteSchema,
  hermesReportSchema,
  hermesUpdateSchema,
  type BotCreateResult,
  type HermesConfig,
  type HermesState,
} from '@ghostlink/shared';
import { BOTS_MODULE_NAME, type BotsModule } from '../bots/index.js';
import { getMeta } from '../db/serverMeta.js';
import { enterpriseOf, type EnterpriseModule } from '../enterprise/index.js';
import type { ModuleContext, RequestHandler, ServerEvent, ServerModule, SessionInfo } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { HermesStore } from './store.js';

interface State {
  ctx: ModuleContext;
  store: HermesStore;
  bots: BotsModule;
  enterprise: EnterpriseModule | null;
  changes: SlidingWindowLimiter;
  reports: SlidingWindowLimiter;
}

export function createCompanyHermesModule(): CompanyHermesModule {
  let state: State | null = null;
  const need = (): State => {
    if (!state) throw new Error('the companyHermes module is not initialized');
    return state;
  };

  const isEnterprise = (s: State): boolean => s.enterprise?.edition === 'enterprise';
  const ownerId = (s: State): string | null => getMeta(s.ctx.db).ownerUserId;
  const requireOwner = (s: State, userId: string): void => {
    if (userId !== ownerId(s)) throw new ProtocolError('FORBIDDEN');
  };
  const requireEnterprise = (s: State): void => {
    if (!isEnterprise(s)) throw new ProtocolError('ENTERPRISE_REQUIRED');
  };
  const sessionsOf = (s: State, userId: string): SessionInfo[] => s.ctx.sessions.list().filter((x) => x.userId === userId);

  /** The owner's view: keys only as their last 4 characters. */
  const stateOf = (s: State): HermesState => {
    const r = s.store.load();
    const last4 = (key: string | null) => (key === null ? null : { last4: key.slice(-4) });
    return {
      botId: r.botId,
      connected: r.botId !== null && sessionsOf(s, r.botId).length > 0,
      locked: !isEnterprise(s),
      keys: { deepseek: last4(r.keys.deepseek), openrouter: last4(r.keys.openrouter) },
      settings: r.settings,
      version: r.version,
      report: r.report,
      reportAt: r.reportAt,
    };
  };

  /** `hermes.config` to the company Hermes's session: the only place its keys ever go. */
  const sendConfig = (s: State, only?: SessionInfo): void => {
    const r = s.store.load();
    if (r.botId === null || !isEnterprise(s)) return;
    const event: ServerEvent = { t: 'hermes.config', d: { version: r.version, keys: r.keys, ...r.settings } satisfies HermesConfig };
    for (const x of only ? [only] : sessionsOf(s, r.botId)) s.ctx.sessions.send(x.sessionId, event);
  };

  /** `hermes.state` to the owner's sessions (the settings open there follow it live). */
  const announce = (s: State): void => {
    const owner = ownerId(s);
    if (owner === null) return;
    const sessions = sessionsOf(s, owner);
    if (sessions.length === 0) return;
    const d = stateOf(s);
    for (const x of sessions) s.ctx.sessions.send(x.sessionId, { t: 'hermes.state', d });
  };

  const handlers: Record<string, RequestHandler> = {
    'hermes.create': (rc, payload): BotCreateResult => {
      const p = hermesCreateSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (s.store.load().botId !== null) throw new ProtocolError('BAD_REQUEST', 'the company Hermes exists');
      const created = s.bots.createBot(rc, p.name);
      s.store.setBot(created.bot.userId);
      announce(s);
      return created;
    },

    'hermes.get': (rc, payload): HermesState => {
      hermesGetSchema.parse(payload ?? {});
      const s = need();
      requireOwner(s, rc.userId);
      return stateOf(s);
    },

    'hermes.update': (rc, payload): HermesState => {
      const p = hermesUpdateSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (!s.changes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      s.store.update(p);
      sendConfig(s);
      announce(s);
      return stateOf(s);
    },

    'hermes.memory.delete': (rc, payload) => {
      const p = hermesMemoryDeleteSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (!s.changes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      const botId = s.store.load().botId;
      if (botId === null) throw new ProtocolError('NOT_FOUND');
      const sent = sessionsOf(s, botId).filter((x) => s.ctx.sessions.send(x.sessionId, { t: 'hermes.memory.delete', d: p })).length;
      if (sent === 0) throw new ProtocolError('BOT_OFFLINE');
      return {};
    },

    'hermes.report': (rc, payload) => {
      const p = hermesReportSchema.parse(payload);
      const s = need();
      if (s.store.load().botId !== rc.userId) throw new ProtocolError('FORBIDDEN');
      requireEnterprise(s);
      if (!s.reports.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      s.store.saveReport(p, s.ctx.now());
      announce(s);
      return {};
    },
  };

  return {
    name: COMPANY_HERMES_MODULE_NAME,
    features: [FEATURE_ENTERPRISE_HERMES],
    handlers,

    init(c) {
      state = {
        ctx: c,
        store: new HermesStore(c.db),
        bots: c.getModule<BotsModule>(BOTS_MODULE_NAME),
        enterprise: enterpriseOf(c),
        changes: new SlidingWindowLimiter(HERMES_LIMITS.changesPerMinute, 60_000, c.now),
        reports: new SlidingWindowLimiter(HERMES_LIMITS.reportsPerMinute, 60_000, c.now),
      };
      const s = state;
      s.enterprise?.onChange((edition) => {
        const botId = s.store.load().botId;
        // Lapsed: disconnected now, refused at the door (auth/botAuth.ts) until a renewal.
        if (edition === 'normal' && botId !== null) s.ctx.sessions.closeUser(botId, 'ENTERPRISE_REQUIRED');
        announce(s);
      });
      // The company Hermes deleted: its bot_id is NULL now; the owner's panel follows.
      c.getModule<TextModule>(TEXT_MODULE_NAME).events.on('membership.removed', () => announce(s));
    },

    welcome: (session) => {
      const s = need();
      return session.userId === ownerId(s) ? { hermes: stateOf(s) } : {};
    },

    onSessionOpened(session) {
      const s = need();
      if (s.store.load().botId !== session.userId) return;
      // The handshake refuses it on a normal server; this covers a lapse in between.
      if (!isEnterprise(s)) {
        s.ctx.sessions.closeUser(session.userId, 'ENTERPRISE_REQUIRED');
        return;
      }
      sendConfig(s, session);
      announce(s);
    },

    onSessionClosed(session, info) {
      const s = need();
      if (!info.graceExpired && s.store.load().botId === session.userId) announce(s);
    },
  };
}
```

- [ ] **Step 5: Refuse the company Hermes at a normal server's door**

`apps/server/src/auth/botAuth.ts`, in `admitBot`, right after the `bans` check:

```ts
    // The company's own Hermes needs an Enterprise server (spec 2026-10-02-enterprise-e-hermes-da-empresa
    // §1); the enterprise module keeps `enterprise.edition` up to date.
    if (
      db.get(
        `SELECT 1 AS x FROM company_hermes WHERE bot_id = ?
         AND NOT EXISTS (SELECT 1 FROM enterprise WHERE id = 1 AND edition = 'enterprise')`,
        botId,
      )
    ) {
      return { ok: false, code: 'ENTERPRISE_REQUIRED', countsAsFailure: false };
    }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- apps/server/test/companyHermes.test.ts apps/server/test/bots.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/server/src/companyHermes/index.ts apps/server/src/companyHermes/store.ts apps/server/src/auth/botAuth.ts apps/server/test/companyHermes.test.ts
git commit -m "feat(server): the company's own Hermes: settings, keys only for its session, live state for the owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track C: the desktop

Read `apps/desktop/src/renderer/features/bots/BotSettings.tsx` and `DjPanel.tsx` first: the new tabs follow their patterns (`SettingsShell` tabs, `s.form` / `s.field` / `s.hint` from `layout/settings.module.css`, `ErrorText`, `primitives` buttons, `ConfirmDialog`, `Select`). Every text is pt-BR **and** en (`enterprise.*.ts`, same keys). The renderer never stores a key: inputs are cleared after a save.

### Task C1: The store, the badge, the banner and the Enterprise tab

**Files:** Create `apps/desktop/src/renderer/stores/enterprise.ts`, `apps/desktop/src/renderer/features/enterprise/{enterpriseModel.ts,enterpriseActions.ts,EnterpriseTab.tsx,EnterpriseBanner.tsx,EnterpriseBadge.tsx,enterprise.module.css}`, `apps/desktop/test/renderer/enterprise.test.ts`; Modify `apps/desktop/src/main/ipc.ts`, `features/server-settings/{access.ts,ServerSettings.tsx}`, `layout/{ChannelSidebar,MainLayout}.tsx`, `i18n/enterprise.{pt-BR,en}.ts`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/renderer/enterprise.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type EnterpriseLicenseInfo, type HermesState } from '@ghostlink/shared';
import { settingsTabs } from '../../src/renderer/features/server-settings/access.js';
import { licenseBanner } from '../../src/renderer/features/enterprise/enterpriseModel.js';
import { enterpriseReducer, initialEnterprise } from '../../src/renderer/stores/enterprise.js';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';

const DAY = 86_400_000;
const info = (o: Partial<EnterpriseLicenseInfo> = {}): EnterpriseLicenseInfo => ({ state: 'valid', company: 'TC Flag', issuedAt: 0, expiresAt: 30 * DAY, graceEndsAt: 37 * DAY, ...o });
const welcome = (extra: Record<string, unknown>) => ({ serverId: 's1', ...extra }) as unknown as RendererWelcome;
const hermes = { botId: 'b'.repeat(32), connected: true, locked: false, keys: { deepseek: null, openrouter: null }, settings: { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null }, disabledSkills: null, access: { roleIds: [], channels: 'all' } }, version: 0, report: null, reportAt: null } satisfies HermesState;

describe('the enterprise store (spec §1, §2)', () => {
  it('starts from the welcome and follows the events of its own server only', () => {
    let s = enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({ enterprise: { edition: 'enterprise', license: info() }, hermes }) });
    expect(s).toMatchObject({ serverId: 's1', edition: 'enterprise', license: { company: 'TC Flag' }, hermes: { connected: true } });
    s = enterpriseReducer(s, { type: 'event', serverId: 's2', envelope: { t: 'enterprise.state', d: { edition: 'normal' } } });
    expect(s.edition).toBe('enterprise');
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'enterprise.state', d: { edition: 'normal' } } });
    expect(s).toMatchObject({ edition: 'normal', license: { company: 'TC Flag' } });
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'hermes.state', d: { ...hermes, connected: false } } });
    expect(s.hermes?.connected).toBe(false);
    expect(enterpriseReducer(s, { type: 'left' })).toEqual(initialEnterprise);
  });

  it('a server before 0.6.0 is normal', () => {
    expect(enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({}) })).toMatchObject({ edition: 'normal', license: null, hermes: null });
  });

  it('warns the owner in the 7 days before expiry and the 7 after (spec §1 "Validade")', () => {
    expect(licenseBanner(info({ state: 'expiring' }), true)).toEqual({ key: 'enterprise.banner.expiring', date: 30 * DAY });
    expect(licenseBanner(info({ state: 'grace' }), true)).toEqual({ key: 'enterprise.banner.grace', date: 37 * DAY });
    expect(licenseBanner(info({ state: 'expiring' }), false)).toBeNull();
    expect(licenseBanner(info(), true)).toBeNull();
    expect(licenseBanner(null, true)).toBeNull();
  });

  it('the Enterprise tab is the owner\'s, on servers that know editions', () => {
    expect(settingsTabs(ALL_PERMISSIONS, true, { enterprise: true })).toContain('enterprise');
    expect(settingsTabs(ALL_PERMISSIONS, false, { enterprise: true })).not.toContain('enterprise');
    expect(settingsTabs(ALL_PERMISSIONS, true)).not.toContain('enterprise');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/desktop/test/renderer/enterprise.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write the store**

`apps/desktop/src/renderer/stores/enterprise.ts`:

```ts
// Enterprise and the company Hermes as this app sees them (spec 2026-10-02-enterprise-e-hermes-da-empresa
// §1, §2): the edition of the server on screen (everyone), its license and the company Hermes's state
// (the owner only). Seeded by the welcome's `enterprise` and `hermes` keys, then kept by the
// `enterprise.state` and `hermes.state` events and by the answers to the owner's own requests.
// A server before 0.6.0 sends none of them: normal.
import { useEffect } from 'react';
import { create } from 'zustand';
import {
  enterpriseStateSchemaClient,
  hermesStateSchemaClient,
  type Edition,
  type EnterpriseLicenseInfo,
  type EnterpriseState,
  type Envelope,
  type HermesState,
} from '@ghostlink/shared';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { useConnectionStore } from './connection.js';

export interface EnterpriseView {
  serverId: string | null;
  edition: Edition;
  /** The owner only; null: none pasted, or not the owner. */
  license: EnterpriseLicenseInfo | null;
  /** The owner only, on servers with the company Hermes. */
  hermes: HermesState | null;
}

export type EnterpriseAction =
  | { type: 'welcome'; welcome: RendererWelcome }
  | { type: 'event'; serverId: string; envelope: Envelope }
  | { type: 'enterprise'; state: EnterpriseState }
  | { type: 'hermes'; state: HermesState }
  | { type: 'left' };

export const initialEnterprise: EnterpriseView = { serverId: null, edition: 'normal', license: null, hermes: null };

function withEnterprise(s: EnterpriseView, d: EnterpriseState): EnterpriseView {
  // Everyone but the owner gets the edition alone: the license they had (none) stays.
  return { ...s, edition: d.edition, license: d.license === undefined ? s.license : d.license };
}

/** Pure reducer behind the store. */
export function enterpriseReducer(s: EnterpriseView, a: EnterpriseAction): EnterpriseView {
  switch (a.type) {
    case 'left':
      return initialEnterprise;
    case 'welcome': {
      const w = a.welcome as RendererWelcome & { enterprise?: unknown; hermes?: unknown };
      const ent = enterpriseStateSchemaClient.safeParse(w.enterprise);
      const hermes = hermesStateSchemaClient.safeParse(w.hermes);
      return {
        serverId: w.serverId,
        edition: ent.success ? ent.data.edition : 'normal',
        license: ent.success ? (ent.data.license ?? null) : null,
        hermes: w.hermes !== undefined && hermes.success ? hermes.data : null,
      };
    }
    case 'enterprise':
      return withEnterprise(s, a.state);
    case 'hermes':
      return { ...s, hermes: a.state };
    case 'event': {
      if (a.serverId !== s.serverId) return s;
      if (a.envelope.t === 'enterprise.state') {
        const p = enterpriseStateSchemaClient.safeParse(a.envelope.d);
        return p.success ? withEnterprise(s, p.data) : s;
      }
      if (a.envelope.t === 'hermes.state') {
        const p = hermesStateSchemaClient.safeParse(a.envelope.d);
        return p.success ? { ...s, hermes: p.data } : s;
      }
      return s;
    }
  }
}

interface EnterpriseStore extends EnterpriseView {
  dispatch(action: EnterpriseAction): void;
}

export const useEnterpriseStore = create<EnterpriseStore>()((set) => ({
  ...initialEnterprise,
  dispatch: (action) => set((s) => enterpriseReducer(s, action)),
}));

/** Mount once (MainLayout): the welcome on screen, then the server's events. */
export function useEnterpriseSync(): void {
  const welcome = useConnectionStore((s) => s.welcome);
  useEffect(() => {
    useEnterpriseStore.getState().dispatch(welcome ? { type: 'welcome', welcome } : { type: 'left' });
  }, [welcome]);
  useEffect(() => window.ghostlink.onServerEvent((envelope, serverId) => useEnterpriseStore.getState().dispatch({ type: 'event', serverId, envelope })), []);
}
```

- [ ] **Step 4: The pure helpers and the requests**

`apps/desktop/src/renderer/features/enterprise/enterpriseModel.ts`:

```ts
import type { EnterpriseLicenseInfo } from '@ghostlink/shared';

/** The owner's band at the top (spec §1 "Validade"): the 7 days before expiry and the 7 after. */
export function licenseBanner(
  license: EnterpriseLicenseInfo | null,
  owner: boolean,
): { key: 'enterprise.banner.expiring' | 'enterprise.banner.grace'; date: number } | null {
  if (!owner || !license || license.expiresAt === null) return null;
  if (license.state === 'expiring') return { key: 'enterprise.banner.expiring', date: license.expiresAt };
  if (license.state === 'grace' && license.graceEndsAt !== null) return { key: 'enterprise.banner.grace', date: license.graceEndsAt };
  return null;
}
```

`apps/desktop/src/renderer/features/enterprise/enterpriseActions.ts`:

```ts
import { enterpriseStateSchemaClient, type EnterpriseState } from '@ghostlink/shared';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { request } from '../chat/actions.js';

/** The owner pastes a license: checked by the server at once (LICENSE_INVALID, LICENSE_EXPIRED). */
export async function setLicense(license: string): Promise<EnterpriseState> {
  const state = await request('enterprise.license.set', { license: license.trim() }, enterpriseStateSchemaClient);
  useEnterpriseStore.getState().dispatch({ type: 'enterprise', state });
  return state;
}
```

- [ ] **Step 5: The tab list and the IPC allowlist**

`apps/desktop/src/renderer/features/server-settings/access.ts`:

```ts
export type ServerSettingsTab = 'overview' | 'channels' | 'roles' | 'members' | 'invites' | 'bans' | 'enterprise' | 'transfer';

export function settingsTabs(bits: number, isOwner: boolean, opts: { enterprise?: boolean } = {}): ServerSettingsTab[] {
  // …existing pushes…
  if (isOwner && opts.enterprise === true) tabs.push('enterprise');
  if (isOwner) tabs.push('transfer');
  return tabs;
}
```

`ServerSettings.tsx`: compute `const enterprise = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_ENTERPRISE) === true);`, pass `{ enterprise }` to `settingsTabs`, and add `enterprise: () => <EnterpriseTab />` to `CONTENT`.

`apps/desktop/src/main/ipc.ts`, in `RENDERER_REQUEST_TYPES` after the DJ line:

```ts
  // Enterprise (v0.6.0): the owner's license, and the company Hermes's settings. hermes.report is the Hermes's own.
  'enterprise.license.set', 'hermes.create', 'hermes.get', 'hermes.update', 'hermes.memory.delete',
```

- [ ] **Step 6: The UI**

- `EnterpriseBadge.tsx`: `useEnterpriseStore((s) => s.edition) === 'enterprise'` → `<span className={e.badge} title={t('enterprise.badgeTitle')}>{t('enterprise.badge')}</span>`; a small uppercase pill (11 px, `var(--accent-soft)` background, `var(--text-bright)` text, as Discord's badges), next to the name. `ChannelSidebar.tsx`: render `<EnterpriseBadge />` right after `<span className={l.serverName}>{name}</span>`.
- `EnterpriseBanner.tsx`: like `DeletionBanner` (owner only, `role="status"`, `aria-label={t('enterprise.bannerLabel')}`), text `t(banner.key, { date: formatDate(banner.date, locale) })` with the date as `dd/mm/aaaa` (`toLocaleDateString(locale)`); amber, not red. `MainLayout.tsx`: call `useEnterpriseSync()` once and render `<EnterpriseBanner />` next to `<DeletionBanner …/>`.
- `EnterpriseTab.tsx` (owner only; the tab list already hides it from others):
  1. `p.text` intro `enterprise.tab.intro`;
  2. the edition line (`enterprise.tab.edition.enterprise` / `.normal`) and, when a license is stored, its state line `enterprise.tab.state.<state>` with `{ company, date: expiresAt, grace: graceEndsAt }`, else `enterprise.tab.none`;
  3. `CopyField` (from `server-settings/InviteDialog.js`) labelled `enterprise.tab.identity` with `welcome.server.serverKeyId`, hint `enterprise.tab.identityHint`;
  4. a `textarea` (`enterprise.tab.paste`, monospace, 4 rows, `spellCheck={false}`), hint `enterprise.tab.pasteHint`, button `enterprise.tab.save` → `setLicense(text)`; on success clear the field and show `enterprise.tab.saved` (`s.ok`); on error `ErrorText` (LICENSE_INVALID / LICENSE_EXPIRED / RATE_LIMITED).

- [ ] **Step 7: The texts**

Add to `enterprise.pt-BR.ts` (and the same keys, in English, to `enterprise.en.ts`):

```ts
  'enterprise.badge': 'Enterprise',
  'enterprise.badgeTitle': 'Servidor Enterprise',
  'serverSettings.tab.enterprise': 'Enterprise',
  'enterprise.tab.intro': 'Servidores Enterprise têm o Hermes da empresa e não têm o Ghost DJ.',
  'enterprise.tab.edition.enterprise': 'Este servidor é Enterprise.',
  'enterprise.tab.edition.normal': 'Este servidor é normal.',
  'enterprise.tab.none': 'Nenhuma licença colada.',
  'enterprise.tab.state.valid': 'Licença de {company}, válida até {date}.',
  'enterprise.tab.state.expiring': 'Licença de {company}: vence em {date}.',
  'enterprise.tab.state.grace': 'Licença de {company}: venceu em {date}. O servidor volta a ser normal em {grace}.',
  'enterprise.tab.state.expired': 'Licença de {company}: venceu em {date}. O servidor voltou a ser normal.',
  'enterprise.tab.state.wrong-server': 'A licença guardada é de outro servidor.',
  'enterprise.tab.state.invalid': 'A licença guardada não pôde ser conferida.',
  'enterprise.tab.identity': 'Identidade do servidor',
  'enterprise.tab.identityHint': 'A licença é feita para esta identidade. Envie-a a quem emite a licença.',
  'enterprise.tab.paste': 'Colar licença',
  'enterprise.tab.pasteHint': 'Uma licença nova substitui a atual na hora, sem reiniciar o servidor.',
  'enterprise.tab.save': 'Salvar licença',
  'enterprise.tab.saved': 'Licença salva.',
  'enterprise.banner.expiring': 'A licença Enterprise deste servidor vence em {date}.',
  'enterprise.banner.grace': 'A licença Enterprise venceu. O servidor volta a ser normal em {date}.',
  'enterprise.bannerLabel': 'Aviso da licença Enterprise',
```

and, after the object in `enterprise.pt-BR.ts`, the keys that read the same in English on purpose (the i18n test allows them):

```ts
/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const ENTERPRISE_SAME_IN_BOTH = ['enterprise.badge', 'serverSettings.tab.enterprise'] as const;
```

`apps/desktop/test/renderer/i18n.test.ts`: import `ENTERPRISE_SAME_IN_BOTH` from `../../src/renderer/i18n/enterprise.pt-BR.js` and add `...ENTERPRISE_SAME_IN_BOTH` to `sameOnPurpose`.

- [ ] **Step 8: Run the test, lint, typecheck, commit**

Run: `npm test -- apps/desktop/test/renderer/enterprise.test.ts apps/desktop/test/renderer/serverSettings.test.ts apps/desktop/test/renderer/i18n.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/stores/enterprise.ts apps/desktop/src/renderer/features/enterprise apps/desktop/src/renderer/features/server-settings/access.ts apps/desktop/src/renderer/features/server-settings/ServerSettings.tsx apps/desktop/src/renderer/layout/ChannelSidebar.tsx apps/desktop/src/renderer/layout/MainLayout.tsx apps/desktop/src/main/ipc.ts apps/desktop/src/renderer/i18n/enterprise.pt-BR.ts apps/desktop/src/renderer/i18n/enterprise.en.ts apps/desktop/test/renderer/enterprise.test.ts apps/desktop/test/renderer/i18n.test.ts
git commit -m "feat(desktop): the Enterprise badge, the license tab and its expiry warning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C2: The company Hermes in the app

**Files:** Create `apps/desktop/src/renderer/features/bots/hermes/{hermesModel.ts,hermesActions.ts,HermesTabs.tsx,hermes.module.css}`, `apps/desktop/test/renderer/hermesModel.test.ts`; Modify `features/bots/{BotSettings,BotsSection,BotDialogs}.tsx`, `i18n/enterprise.{pt-BR,en}.ts`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/renderer/hermesModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HERMES_DEFAULT_SETTINGS, type HermesReport, type HermesState } from '@ghostlink/shared';
import { canCreateCompanyHermes, providersWithKeys, skillEnabled, statusLines, toggledSkills } from '../../src/renderer/features/bots/hermes/hermesModel.js';

const report: HermesReport = {
  appliedVersion: 2,
  skills: [
    { name: 'hermes-agent', description: '', enabled: true, locked: true },
    { name: 'resumo', description: '', enabled: true, locked: false },
    { name: 'planilhas', description: '', enabled: false, locked: false },
  ],
  memory: { company: [], people: [] },
  status: { model: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null, keys: { deepseek: 'refused', openrouter: 'missing' }, unsupported: null, envOverride: ['openrouter'] },
};
const state = (o: Partial<HermesState> = {}): HermesState => ({
  botId: 'b'.repeat(32), connected: true, locked: false, keys: { deepseek: { last4: 'ab12' }, openrouter: null },
  settings: HERMES_DEFAULT_SETTINGS, version: 2, report, reportAt: 0, ...o,
});

describe('the company Hermes panel (spec §2)', () => {
  it('offers models only from providers with a key', () => {
    expect(providersWithKeys(state())).toEqual(['deepseek']);
  });

  it('switches skills from what the Hermes reported until the server has its own list', () => {
    expect(skillEnabled(state(), report.skills[2]!)).toBe(false);
    expect(toggledSkills(state(), 'resumo', false)).toEqual(['planilhas', 'resumo']);
    const managed = state({ settings: { ...HERMES_DEFAULT_SETTINGS, disabledSkills: ['resumo'] } });
    expect(skillEnabled(managed, report.skills[1]!)).toBe(false);
    expect(skillEnabled(managed, report.skills[0]!)).toBe(true);
    expect(toggledSkills(managed, 'resumo', true)).toEqual([]);
  });

  it('says how it is: lapsed first, then connection, applying, model and key problems', () => {
    expect(statusLines(state({ locked: true, connected: false, version: 3 })).map((l) => l.key)).toEqual([
      'hermes.status.locked', 'hermes.status.disconnected', 'hermes.status.model', 'hermes.status.keyRefused', 'hermes.status.envOverride',
    ]);
    expect(statusLines(state({ version: 3 })).map((l) => l.key)).toContain('hermes.status.applying');
  });

  it('"Hermes da empresa" in "Adicionar bot": the owner of an Enterprise server without one', () => {
    const none = state({ botId: null });
    expect(canCreateCompanyHermes({ owner: true, edition: 'enterprise', hermes: none })).toBe(true);
    expect(canCreateCompanyHermes({ owner: false, edition: 'enterprise', hermes: none })).toBe(false);
    expect(canCreateCompanyHermes({ owner: true, edition: 'normal', hermes: none })).toBe(false);
    expect(canCreateCompanyHermes({ owner: true, edition: 'enterprise', hermes: state() })).toBe(false);
    expect(canCreateCompanyHermes({ owner: true, edition: 'enterprise', hermes: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/desktop/test/renderer/hermesModel.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `hermesModel.ts`**

```ts
import { HERMES_PROVIDERS, type Edition, type HermesProvider, type HermesSkill, type HermesState } from '@ghostlink/shared';
import type { MessageKey, Vars } from '../../../i18n/index.js';

export const PROVIDER_NAMES: Record<HermesProvider, string> = { deepseek: 'DeepSeek', openrouter: 'OpenRouter' };

/** Providers the owner may pick models from (spec §2 "Modelos"): the ones with a key saved. */
export function providersWithKeys(state: HermesState): HermesProvider[] {
  return HERMES_PROVIDERS.filter((p) => state.keys[p] !== null);
}

/** The server's list once it has one; before that, what the Hermes reported. */
function disabledNow(state: HermesState): string[] {
  return state.settings.disabledSkills ?? state.report?.skills.filter((s) => !s.enabled && !s.locked).map((s) => s.name) ?? [];
}

export function skillEnabled(state: HermesState, skill: HermesSkill): boolean {
  return skill.locked || !disabledNow(state).includes(skill.name);
}

/** The whole disabled list after switching one skill (what hermes.update sends). */
export function toggledSkills(state: HermesState, name: string, enabled: boolean): string[] {
  const set = new Set(disabledNow(state));
  if (enabled) set.delete(name);
  else set.add(name);
  return [...set].sort();
}

export interface HermesLine {
  key: MessageKey;
  vars?: Vars;
  tone: 'ok' | 'warn' | 'error';
}

/** "Situação" (spec §2): the most important first. */
export function statusLines(state: HermesState): HermesLine[] {
  const lines: HermesLine[] = [];
  const r = state.report;
  if (state.locked) lines.push({ key: 'hermes.status.locked', tone: 'error' });
  lines.push(state.connected ? { key: 'hermes.status.connected', tone: 'ok' } : { key: 'hermes.status.disconnected', tone: 'warn' });
  if (r?.status.unsupported) lines.push({ key: 'hermes.status.unsupported', tone: 'error' });
  if (state.connected && r !== null && r.appliedVersion < state.version) lines.push({ key: 'hermes.status.applying', tone: 'warn' });
  if (r?.status.model) lines.push({ key: 'hermes.status.model', vars: { model: r.status.model.model }, tone: 'ok' });
  for (const p of HERMES_PROVIDERS) {
    const k = r?.status.keys[p];
    if (k === 'refused') lines.push({ key: 'hermes.status.keyRefused', vars: { provider: PROVIDER_NAMES[p] }, tone: 'error' });
    if (k === 'unreachable') lines.push({ key: 'hermes.status.keyUnreachable', vars: { provider: PROVIDER_NAMES[p] }, tone: 'warn' });
  }
  for (const p of r?.status.envOverride ?? []) lines.push({ key: 'hermes.status.envOverride', vars: { provider: PROVIDER_NAMES[p] }, tone: 'warn' });
  return lines;
}

/** "Hermes da empresa" in "Adicionar bot" (spec §2 "Criar"). `hermes` is null on servers without it. */
export function canCreateCompanyHermes(o: { owner: boolean; edition: Edition; hermes: HermesState | null }): boolean {
  return o.owner && o.edition === 'enterprise' && o.hermes !== null && o.hermes.botId === null;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- apps/desktop/test/renderer/hermesModel.test.ts`
Expected: PASS.

- [ ] **Step 5: The requests**

`hermesActions.ts`:

```ts
import { z } from 'zod';
import {
  botCreateResultSchemaClient,
  hermesStateSchemaClient,
  type BotCreateResult,
  type HermesMemoryTarget,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import { useEnterpriseStore } from '../../../stores/enterprise.js';
import { request } from '../../chat/actions.js';

/** A bot marked as the company Hermes; its code shows once (for GHOSTLINK_BOT on Railway). */
export function createCompanyHermes(name: string): Promise<BotCreateResult> {
  return request('hermes.create', { name: name.trim() }, botCreateResultSchemaClient);
}

/** Saves a change; the answer (and hermes.state) refresh the panel. A key passed here is never kept. */
export async function updateHermes(patch: HermesUpdatePayload): Promise<HermesState> {
  const state = await request('hermes.update', { ...patch }, hermesStateSchemaClient);
  useEnterpriseStore.getState().dispatch({ type: 'hermes', state });
  return state;
}

/** The Hermes removes the item and reports the new list (BOT_OFFLINE while it is disconnected). */
export async function deleteHermesMemory(target: HermesMemoryTarget, id: string): Promise<void> {
  await request('hermes.memory.delete', { target, id }, z.object({}));
}
```

- [ ] **Step 6: The five tabs**

`HermesTabs.tsx` exports `hermesSettingsTabs(t: Translate): SettingsTab[]` (ids `hermesKeys`, `hermesModels`, `hermesSkills`, `hermesAccess`, `hermesMemory`, labels `hermes.tab.keys` … `hermes.tab.memory`) whose contents read `useEnterpriseStore((s) => s.hermes)`. Every tab starts with `<HermesStatus state={state} />` (one line per `statusLines(state)`, a dot coloured by tone), and every control is disabled while `state.locked`. A save shows `hermes.saved`; errors use `ErrorText`.

- **Chaves de IA** — one row per provider; the key never stays in React state after a save:

```tsx
function KeyRow({ provider, state }: { provider: HermesProvider; state: HermesState }) {
  const t = useT();
  const id = useId();
  const saved = state.keys[provider];
  const [editing, setEditing] = useState(saved === null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const name = PROVIDER_NAMES[provider];

  const save = async (key: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await updateHermes({ keys: { [provider]: key } });
      setValue('');
      setEditing(false);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.field} data-hermes-key={provider}>
      <label htmlFor={id} className={s.label}>{name}</label>
      <p className={s.hint}>{saved ? t('hermes.keys.set', { last4: saved.last4 }) : t('hermes.keys.none')}</p>
      {editing ? (
        <form className={s.row} onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(value); }}>
          <input id={id} className={s.input} type="password" autoComplete="off" spellCheck={false} placeholder={t('hermes.keys.paste')}
            value={value} disabled={busy || state.locked} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || state.locked || value.trim() === ''}>{t('hermes.keys.save')}</button>
        </form>
      ) : (
        <div className={s.row}>
          <button type="button" className={p.button} disabled={state.locked} onClick={() => setEditing(true)}>{t('hermes.keys.change')}</button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={state.locked} onClick={() => setConfirming(true)}>{t('hermes.keys.delete')}</button>
        </div>
      )}
      {error && <ErrorText code={error} />}
      {confirming && (
        <ConfirmDialog title={t('hermes.keys.deleteTitle', { provider: name })} body={t('hermes.keys.deleteBody', { provider: name })}
          confirmLabel={t('hermes.keys.delete')} onConfirm={() => save(null)} onClose={() => setConfirming(false)} />
      )}
    </section>
  );
}
```

- **Modelos** — "Modelo principal" and "Modelo reserva": a `Select` of `providersWithKeys(state)` (the reserve adds `hermes.models.noFallback`) and a text input for the model id (pre-filled with `state.settings.models`; `<datalist>` suggestions `deepseek-v4-pro`, `deepseek-flash`, `deepseek/deepseek-v4-pro`); "Salvar modelos" → `updateHermes({ models })`. No provider with a key: only `hermes.models.noKeys`.
- **Skills** — `hermes.skills.intro`; one row per `state.report?.skills` (name bold, description below) with a checkbox `checked={skillEnabled(state, skill)}`, disabled when `skill.locked` (title `hermes.skills.locked`) or locked state; a change sends `updateHermes({ disabledSkills: toggledSkills(state, skill.name, checked) })`. Not connected: `hermes.status.disconnected` and `hermes.skills.lastSeen` with `reportAt`; no report: `hermes.skills.none`.
- **Quem pode usar** — role checkboxes (every role but `@todos`, from `useTextStore((s) => s.server.roles)`) with `hermes.access.rolesHint`; channel radios `hermes.access.all` / `hermes.access.chosen` and, for "chosen", checkboxes of the text channels; `hermes.access.mentionHint`; "Salvar" → `updateHermes({ access })`.
- **Memória** — `hermes.memory.intro`; two lists, `hermes.memory.company` and `hermes.memory.people`, each item's text with a trash button (`aria-label={t('hermes.memory.delete')}`) → `deleteHermesMemory(target, item.id)`; buttons disabled while not connected; empty: `hermes.memory.empty`.

- [ ] **Step 7: Wire them in**

- `BotSettings.tsx`: `const hermes = useEnterpriseStore((st) => st.hermes); const owner = useTextStore((st) => isOwner(st.server)); const companyHermes = hermes?.botId === botId;` Insert `...(companyHermes && owner ? hermesSettingsTabs(t) : [])` right after the overview tab, and drop `code` and `delete` when `companyHermes && !owner` (the server refuses them anyway).
- `BotsSection.tsx`: hide "Gerar novo código" and "Excluir bot" in the menu of the company Hermes for anyone but the owner.
- `BotDialogs.tsx`: `AddBotDialog` reads `canCreateCompanyHermes({ owner, edition, hermes })`; when true it shows two radios first (`hermes.create.kind.regular` / `hermes.create.kind.hermes`, hint `hermes.create.hermesHint`), and "Hermes da empresa" pre-fills the name with "Hermes" and calls `createCompanyHermes(name)` instead of `createBot(name)`. `BotCodeDialog` gets an optional `note` prop; for the company Hermes it shows `hermes.code.railway`.

- [ ] **Step 8: The texts**

Add to `enterprise.pt-BR.ts` (and in English to `enterprise.en.ts`):

```ts
  'hermes.create.kind': 'Tipo de bot',
  'hermes.create.kind.regular': 'Bot comum',
  'hermes.create.kind.hermes': 'Hermes da empresa',
  'hermes.create.hermesHint': 'O assistente desta empresa. Só existe um por servidor, e só o dono o configura.',
  'hermes.code.railway': 'Cole este código na variável GHOSTLINK_BOT do serviço do Hermes no Railway.',
  'hermes.tab.keys': 'Chaves de IA',
  'hermes.tab.models': 'Modelos',
  'hermes.tab.skills': 'Skills',
  'hermes.tab.access': 'Quem pode usar',
  'hermes.tab.memory': 'Memória',
  'hermes.status.connected': 'Conectado',
  'hermes.status.disconnected': 'Hermes desconectado',
  'hermes.status.model': 'Modelo em uso: {model}',
  'hermes.status.applying': 'Aplicando as mudanças…',
  'hermes.status.locked': 'A licença Enterprise venceu: as configurações estão guardadas, mas travadas.',
  'hermes.status.unsupported': 'Versão do Hermes não suportada: nada foi aplicado.',
  'hermes.status.keyRefused': 'A {provider} recusou a chave.',
  'hermes.status.keyUnreachable': 'Não foi possível falar com a {provider} para testar a chave.',
  'hermes.status.envOverride': 'Uma chave da {provider} no .env do Hermes tem prioridade sobre a daqui.',
  'hermes.keys.intro': 'As chaves são da empresa. Depois de salvas, só aparecem os últimos 4 caracteres.',
  'hermes.keys.none': 'não configurada',
  'hermes.keys.set': 'configurada (final {last4})',
  'hermes.keys.paste': 'Cole a chave',
  'hermes.keys.save': 'Salvar chave',
  'hermes.keys.change': 'Trocar',
  'hermes.keys.delete': 'Apagar',
  'hermes.keys.deleteTitle': 'Apagar a chave da {provider}?',
  'hermes.keys.deleteBody': 'O Hermes deixa de usar a {provider} até uma chave nova ser salva.',
  'hermes.models.intro': 'Só aparecem os provedores com chave.',
  'hermes.models.primary': 'Modelo principal',
  'hermes.models.fallback': 'Modelo reserva',
  'hermes.models.provider': 'Provedor',
  'hermes.models.model': 'Modelo',
  'hermes.models.noFallback': 'Sem reserva',
  'hermes.models.noKeys': 'Salve uma chave em Chaves de IA primeiro.',
  'hermes.models.save': 'Salvar modelos',
  'hermes.skills.intro': 'Desligar o que não é usado deixa cada conversa mais barata. Vale a partir da próxima conversa.',
  'hermes.skills.none': 'O Hermes ainda não informou as skills.',
  'hermes.skills.locked': 'Essencial: sempre ligada.',
  'hermes.skills.lastSeen': 'Última lista recebida {time}.',
  'hermes.access.roles': 'Cargos que podem falar com ele',
  'hermes.access.rolesHint': 'O dono do servidor sempre pode.',
  'hermes.access.channels': 'Canais onde ele responde',
  'hermes.access.all': 'Todos os canais',
  'hermes.access.chosen': 'Só os escolhidos',
  'hermes.access.mentionHint': 'Ele responde só quando alguém o menciona ou responde a ele.',
  'hermes.access.save': 'Salvar',
  'hermes.memory.intro': 'O que ele guardou. Apagar o que não serve deixa cada conversa mais barata.',
  'hermes.memory.company': 'Sobre a empresa',
  'hermes.memory.people': 'Sobre as pessoas',
  'hermes.memory.empty': 'Nada guardado.',
  'hermes.memory.delete': 'Apagar item',
  'hermes.saved': 'Salvo. O Hermes aplica em alguns segundos.',
```

and add `'hermes.tab.skills'` to `ENTERPRISE_SAME_IN_BOTH` ("Skills" in both languages).

- [ ] **Step 9: Lint, typecheck, run the renderer tests, commit**

Run: `npm run lint && npm run typecheck && npm test -- apps/desktop/test/renderer/hermesModel.test.ts apps/desktop/test/renderer/bots.test.ts apps/desktop/test/renderer/i18n.test.ts`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/features/bots/hermes apps/desktop/src/renderer/features/bots/BotSettings.tsx apps/desktop/src/renderer/features/bots/BotsSection.tsx apps/desktop/src/renderer/features/bots/BotDialogs.tsx apps/desktop/src/renderer/i18n/enterprise.pt-BR.ts apps/desktop/src/renderer/i18n/enterprise.en.ts apps/desktop/test/renderer/hermesModel.test.ts
git commit -m "feat(desktop): the company Hermes: create it, and its keys, models, skills, access and memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track D: the Hermes plugin

### Task D1: `company.py` — applying the config and reading back (no Hermes imports)

**Files:** Create `integrations/hermes-agent/ghostlink/company.py`, `integrations/hermes-agent/test/company_check.py`, `integrations/hermes-agent/test/company.test.ts`.

- [ ] **Step 1: Write the failing check**

`integrations/hermes-agent/test/company_check.py`:

```python
"""Checks ghostlink/company.py on a scratch HERMES_HOME (spec 2026-10-02-enterprise-e-hermes-da-empresa
§3, §6): models, skills, keys only in the environment, backups, an unknown shape refused, memory read and
an item deleted, access decisions. No Hermes install and no network. Prints "ok" at the end."""

import asyncio
import hashlib
import os
import secrets
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import Timing, reconnect_delay  # noqa: E402
from company import CompanyAgent, CompanyHome, memory_id  # noqa: E402

home = Path(tempfile.mkdtemp(prefix="ghostlink-company-"))
(home / "config.yaml").write_text(
    "# TC Hermes\nmodel:\n  provider: deepseek\n  default: deepseek-v4-pro\n"
    "fallback_model:\n  provider: openrouter\n  model: deepseek/deepseek-v4-pro\n"
    "plugins:\n  enabled: [ghostlink]\n", encoding="utf-8")
for rel, name, desc in (("hermes-agent", "hermes-agent", "Manual"), ("geral/resumo", "resumo", "Resume conversas"),
                        ("geral/resumo/scripts/x", "nao-e-skill", "x"), (".hub/y", "escondida", "x")):
    (home / "skills" / rel).mkdir(parents=True, exist_ok=True)
    (home / "skills" / rel / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\ncorpo\n", encoding="utf-8")
(home / "memories").mkdir()
(home / "memories" / "MEMORY.md").write_text("A TC Flag fabrica bandeiras.\n§\nO estoque fica em Guarulhos.", encoding="utf-8")
(home / "memories" / "USER.md").write_text("Matheus prefere respostas curtas.", encoding="utf-8")

env = {}
company = CompanyHome(home, environ=env)
fake_key = "sk-test-ok-" + secrets.token_hex(12)  # made at run time, never a real key

config = {"version": 1, "keys": {"deepseek": fake_key, "openrouter": None},
          "models": {"primary": {"provider": "deepseek", "model": "deepseek-flash"}, "fallback": None},
          "disabledSkills": ["resumo", "hermes-agent"], "access": {"roleIds": ["R" * 26], "channels": "all"}}
changed = company.apply(config)
text = (home / "config.yaml").read_text(encoding="utf-8")
assert changed == {"config": True, "keys": ["deepseek"]}, changed
assert "# TC Hermes" in text and "default: deepseek-flash" in text and "fallback_model" not in text, text
assert "hermes-agent" not in text.split("disabled:")[1], "the essential skill is never disabled"
assert env == {"DEEPSEEK_API_KEY": fake_key}, "keys only in the environment"
assert all(fake_key not in p.read_text(encoding="utf-8", errors="replace") for p in home.rglob("*") if p.is_file()), "never on disk"
assert len(list((home / "ghostlink" / "backups").glob("config.yaml.*"))) == 1
assert company.apply(config) == {"config": False, "keys": []}, "the same config changes nothing"

# fallback_providers, when the file uses it, takes the fallback; 6 changes keep 5 backups.
(home / "config.yaml").write_text(text + "fallback_providers: []\n", encoding="utf-8")
for i in range(6):
    company.apply({**config, "models": {"primary": {"provider": "deepseek", "model": f"m{i}"},
                                        "fallback": {"provider": "openrouter", "model": "x/y"}}})
assert "provider: openrouter" in (home / "config.yaml").read_text(encoding="utf-8").split("fallback_providers:")[1]
assert len(list((home / "ghostlink" / "backups").glob("config.yaml.*"))) == 5
assert company.models() == ({"provider": "deepseek", "model": "m5"}, {"provider": "openrouter", "model": "x/y"})

skills = company.skills()
assert [s["name"] for s in skills] == ["hermes-agent", "resumo"], skills
assert skills[0]["locked"] and skills[0]["enabled"] and not skills[1]["enabled"]
company.apply({**config, "disabledSkills": None})
assert company.skills()[1]["enabled"] is False, "null keeps Hermes's own list"

memory = company.memory()
assert [m["text"] for m in memory["company"]] == ["A TC Flag fabrica bandeiras.", "O estoque fica em Guarulhos."]
assert memory["people"][0]["id"] == hashlib.sha256("Matheus prefere respostas curtas.".encode()).hexdigest()[:16]
assert company.delete_memory("company", memory_id("O estoque fica em Guarulhos.")) is True
assert (home / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "A TC Flag fabrica bandeiras."
assert company.delete_memory("company", "0" * 16) is False

# .env holding a key wins in Hermes: reported, never read aloud.
(home / ".env").write_text("OPENROUTER_API_KEY=" + "x" * 20 + "\n", encoding="utf-8")
assert company.env_override() == ["openrouter"]

# An unknown shape: nothing applied, nothing changed.
before = (home / "config.yaml").read_bytes()
(home / "config.yaml").write_text("- uma\n- lista\n", encoding="utf-8")
broken = (home / "config.yaml").read_bytes()
assert company.check() is not None
try:
    company.apply({**config, "keys": {"deepseek": "sk-test-ok-" + secrets.token_hex(12), "openrouter": None}})
    raise AssertionError("must refuse")
except Exception as exc:  # Unsupported
    assert type(exc).__name__ == "Unsupported"
assert (home / "config.yaml").read_bytes() == broken and env == {"DEEPSEEK_API_KEY": fake_key}
(home / "config.yaml").write_bytes(before)

# The agent: access decisions, and a report without network.
sent = []


async def request(t, d):
    sent.append((t, d))
    return {}


async def check_key(provider, key):
    return "ok" if key.startswith("sk-test-ok-") else "refused"


async def agent_flow():
    agent = CompanyAgent(company, request=request, check_key=check_key)
    assert await agent.on_event("msg.new", {}) is False
    await agent.on_event("hermes.config", {**config, "version": 7, "access": {"roleIds": ["R" * 26], "channels": ["C" * 26]}})
    assert agent.allows("o" * 32, "o" * 32, []) and agent.allows("a" * 32, "o" * 32, ["R" * 26])
    assert not agent.allows("z" * 32, "o" * 32, ["X" * 26])
    assert agent.listens_in("C" * 26) and not agent.listens_in("D" * 26)
    reports = [d for t, d in sent if t == "hermes.report"]
    assert reports[-1]["appliedVersion"] == 7 and reports[-1]["status"]["keys"]["deepseek"] == "ok", reports[-1]
    assert all(fake_key not in str(d) for _, d in sent), "the report never carries a key"


asyncio.run(agent_flow())

# ENTERPRISE_REQUIRED waits 2 minutes between tries.
assert reconnect_delay("ENTERPRISE_REQUIRED", 0, Timing(), lambda: 0.5) == 120.0
assert reconnect_delay("CONNECTION_LOST", 0, Timing(), lambda: 0.5) == 1.0
print("ok")
```

`integrations/hermes-agent/test/company.test.ts`:

```ts
// ghostlink/company.py on its own (company_check.py): skipped where Python with ruamel.yaml and aiohttp
// is missing (GHOSTLINK_TEST_PYTHON picks the interpreter; CI's Linux job has one).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./company_check.py', import.meta.url));

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

describe.skipIf(PYTHON === null)('the company Hermes plugin code (spec §3)', () => {
  it('applies models, skills, keys and access, keeps backups, refuses an unknown shape and deletes memory', () => {
    const r = spawnSync(PYTHON!, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- integrations/hermes-agent/test/company.test.ts` (with a Python that has `aiohttp` and `ruamel.yaml`; see Task D3 for the venv)
Expected: FAIL — `company` does not exist (and `reconnect_delay` is not in client.py yet).

- [ ] **Step 3: Write `integrations/hermes-agent/ghostlink/company.py`**

```python
"""The company's own Hermes (GhostLink spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §3).

GhostLink sends `hermes.config` only to the bot marked as the company Hermes, over its pinned TLS session.
This module applies it to $HERMES_HOME and reads back what `hermes.report` tells, with no Hermes imports
(../test/company_check.py runs it alone):

- the AI keys go to this process's environment only (DEEPSEEK_API_KEY, OPENROUTER_API_KEY), never to a
  file: Hermes reads them every turn (hermes_cli.config.get_env_value_prefer_dotenv: $HERMES_HOME/.env
  first, then the environment), and GhostLink sends them again on every connection;
- the models go to config.yaml `model.provider` / `model.default`; the fallback to `fallback_providers`
  when the file has it, else to the legacy `fallback_model`;
- the skills to config.yaml `skills.disabled`, Hermes's own switch (`hermes-agent` is never off); null
  leaves Hermes's own list alone;
- roles and channels stay in memory, in CompanyAgent;
- config.yaml and the memory files are copied to $HERMES_HOME/ghostlink/backups/ before each write (the
  5 newest kept). A file in a shape this module does not know stops everything: "versão do Hermes não
  suportada". Nothing here ever logs a key or the config.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, MutableMapping, Optional, Tuple

logger = logging.getLogger(__name__)

PROVIDER_ENV = {"deepseek": "DEEPSEEK_API_KEY", "openrouter": "OPENROUTER_API_KEY"}
KEY_CHECK_URLS = {"deepseek": "https://api.deepseek.com/models", "openrouter": "https://openrouter.ai/api/v1/key"}
ESSENTIAL_SKILLS = frozenset({"hermes-agent"})
ENTRY_DELIMITER = "\n§\n"
MEMORY_FILES = {"company": "MEMORY.md", "people": "USER.md"}
SKIP_DIRS = frozenset({".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv",
                       "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache",
                       ".mypy_cache", ".ruff_cache", "_org"})
SUPPORT_DIRS = frozenset({"references", "templates", "assets", "scripts"})
BACKUPS_KEPT = 5
# packages/shared/src/companyHermes.ts HERMES_LIMITS (counted in UTF-16 units, as JavaScript does).
MAX_SKILLS, SKILL_NAME_MAX, SKILL_DESCRIPTION_MAX = 200, 64, 200
MAX_MEMORY_ITEMS, MEMORY_ITEM_MAX, REASON_MAX = 60, 1000, 200


class Unsupported(Exception):
    """A Hermes file is not in a shape this plugin knows: nothing is applied."""


def memory_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _fit(text: str, limit: int) -> str:
    """At most `limit` UTF-16 units (JavaScript's string length), with an ellipsis when cut."""
    if len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    while len((text + "…").encode("utf-16-le")) // 2 > limit:
        text = text[:-1]
    return text + "…"


def _round_trip():
    try:
        from ruamel.yaml import YAML
    except ImportError:
        return None
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 4096
    return y


def _load_yaml(text: str) -> Any:
    rt = _round_trip()
    try:
        if rt is not None:
            return rt.load(text)
        import yaml  # PyYAML, for an older Hermes (comments are then lost on write)
        return yaml.safe_load(text)
    except ImportError as exc:
        raise Unsupported("no YAML library (ruamel.yaml or PyYAML)") from exc
    except Exception as exc:  # the parser's own error types
        raise Unsupported(f"config.yaml does not parse ({type(exc).__name__})") from exc


def _dump_yaml(data: Any) -> str:
    rt = _round_trip()
    if rt is not None:
        out = io.StringIO()
        rt.dump(data, out)
        return out.getvalue()
    import yaml
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


def _frontmatter(text: str) -> Dict[str, Any]:
    text = text.removeprefix("\ufeff")
    end = re.search(r"\n---\s*\n", text[3:]) if text.startswith("---") else None
    if not end:
        return {}
    try:
        data = _load_yaml(text[3:end.start() + 3])
    except Unsupported:
        return {}
    return dict(data) if isinstance(data, dict) else {}


def _names(value: Any) -> set:
    if value is None:
        return set()
    if isinstance(value, str):
        value = [value]
    return {str(v).strip() for v in value if str(v).strip()}


def _entries(raw: str) -> List[str]:
    return [e for e in (x.strip() for x in raw.split(ENTRY_DELIMITER)) if e]


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.ghostlink.tmp")
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


@contextlib.contextmanager
def _locked(path: Path):
    """Hermes's own memory lock (tools/memory_tool_store.py): an exclusive lock on <file>.lock."""
    lock = path.with_name(path.name + ".lock")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        except ImportError:  # Windows (a developer's tests)
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        yield
    finally:
        os.close(fd)


class CompanyHome:
    """The files of one Hermes ($HERMES_HOME) as the company Hermes needs them."""

    def __init__(self, home: Path, environ: MutableMapping[str, str] = os.environ):
        self.home = Path(home)
        self.environ = environ
        self.config_path = self.home / "config.yaml"
        self.backups = self.home / "ghostlink" / "backups"

    # ---- config.yaml ----

    def _read_config(self) -> Any:
        if not self.config_path.exists():
            return _load_yaml("{}\n")
        data = _load_yaml(self.config_path.read_text(encoding="utf-8-sig"))
        if data is None:
            return _load_yaml("{}\n")
        if not isinstance(data, dict):
            raise Unsupported("config.yaml is not a mapping")
        if data.get("model") is not None and not isinstance(data.get("model"), (str, dict)):
            raise Unsupported("config.yaml: model")
        for key, kinds in (("fallback_model", (dict, list)), ("fallback_providers", (list,)), ("skills", (dict,))):
            if data.get(key) is not None and not isinstance(data.get(key), kinds):
                raise Unsupported(f"config.yaml: {key}")
        disabled = (data.get("skills") or {}).get("disabled")
        if disabled is not None and not isinstance(disabled, (list, str)):
            raise Unsupported("config.yaml: skills.disabled")
        return data

    def check(self) -> Optional[str]:
        """None when every file is in a known shape, else why not."""
        try:
            self._read_config()
            for name in MEMORY_FILES.values():
                path = self.home / "memories" / name
                if path.exists():
                    path.read_text(encoding="utf-8-sig")
        except Unsupported as exc:
            return str(exc)
        except (OSError, UnicodeDecodeError) as exc:
            return f"unreadable file ({type(exc).__name__})"
        return None

    def apply(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Models and skills into config.yaml, keys into the environment. Raises Unsupported first,
        before anything changes."""
        if (reason := self.check()) is not None:
            raise Unsupported(reason)
        data = self._read_config()
        before = _dump_yaml(data)
        models = config.get("models") or {}
        primary, fallback = models.get("primary"), models.get("fallback")
        if primary:
            model = data.get("model")
            if not isinstance(model, dict):
                data["model"] = model = _load_yaml("{}\n")
            model["provider"], model["default"] = primary["provider"], primary["model"]
        if "fallback_providers" in data:
            data["fallback_providers"] = [{"provider": fallback["provider"], "model": fallback["model"]}] if fallback else []
        elif fallback:
            data["fallback_model"] = {"provider": fallback["provider"], "model": fallback["model"]}
        else:
            data.pop("fallback_model", None)
        if config.get("disabledSkills") is not None:
            skills = data.get("skills")
            if not isinstance(skills, dict):
                data["skills"] = skills = _load_yaml("{}\n")
            skills["disabled"] = sorted(_names(config["disabledSkills"]) - ESSENTIAL_SKILLS)
        after = _dump_yaml(data)
        changed = after != before
        if changed:
            if self.config_path.exists():
                self._backup(self.config_path)
            _write_atomic(self.config_path, after)
        return {"config": changed, "keys": self._set_keys(config.get("keys") or {})}

    def _set_keys(self, keys: Dict[str, Optional[str]]) -> List[str]:
        """The AI keys, in this process's environment only. Returns the providers whose key changed."""
        changed = []
        for provider, var in PROVIDER_ENV.items():
            value = keys.get(provider)
            if value:
                if self.environ.get(var) != value:
                    self.environ[var] = value
                    changed.append(provider)
            elif var in self.environ:
                del self.environ[var]
                changed.append(provider)
        return changed

    def env_override(self) -> List[str]:
        """Providers whose key is also in $HERMES_HOME/.env, which Hermes prefers (names only, never values)."""
        try:
            lines = (self.home / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines()
        except OSError:
            return []
        return [p for p, var in PROVIDER_ENV.items()
                if any(re.match(rf"^\s*(export\s+)?{var}\s*=\s*\S", line) for line in lines)]

    def models(self) -> Tuple[Optional[Dict[str, str]], Optional[Dict[str, str]]]:
        data = self._read_config()
        model = data.get("model")
        primary = None
        if isinstance(model, dict) and model.get("default"):
            primary = {"provider": str(model.get("provider") or ""), "model": str(model["default"])}
        elif isinstance(model, str) and model:
            primary = {"provider": "", "model": model}
        chain = data.get("fallback_providers") if data.get("fallback_providers") is not None else data.get("fallback_model")
        first = chain[0] if isinstance(chain, list) and chain else chain
        fallback = None
        if isinstance(first, dict) and first.get("provider") and first.get("model"):
            fallback = {"provider": str(first["provider"]), "model": str(first["model"])}
        return primary, fallback

    # ---- skills and memory ----

    def skills(self) -> List[Dict[str, Any]]:
        disabled = _names((self._read_config().get("skills") or {}).get("disabled"))
        found = []
        for dirpath, dirnames, filenames in os.walk(self.home / "skills"):
            is_skill = "SKILL.md" in filenames
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not (is_skill and d in SUPPORT_DIRS))
            if not is_skill:
                continue
            meta = _frontmatter((Path(dirpath) / "SKILL.md").read_text(encoding="utf-8-sig", errors="replace"))
            name = re.sub(r"[\x00-\x1f\x7f]", "", str(meta.get("name") or Path(dirpath).name)).strip()
            if not name:
                continue
            locked = name in ESSENTIAL_SKILLS
            found.append({"name": _fit(name, SKILL_NAME_MAX), "description": _fit(" ".join(str(meta.get("description") or "").split()), SKILL_DESCRIPTION_MAX),
                          "enabled": locked or name not in disabled, "locked": locked})
        found.sort(key=lambda s: s["name"].lower())
        return found[:MAX_SKILLS]

    def memory(self) -> Dict[str, List[Dict[str, str]]]:
        out = {}
        for target, name in MEMORY_FILES.items():
            try:
                raw = (self.home / "memories" / name).read_text(encoding="utf-8-sig")
            except FileNotFoundError:
                raw = ""
            items = list(dict.fromkeys(_entries(raw)))[:MAX_MEMORY_ITEMS]
            out[target] = [{"id": memory_id(t), "text": _fit(t, MEMORY_ITEM_MAX)} for t in items]
        return out

    def delete_memory(self, target: str, item_id: str) -> bool:
        """Removes the entry with that id (under Hermes's lock). False when there is none."""
        path = self.home / "memories" / MEMORY_FILES[target]
        if not path.exists():
            return False
        with _locked(path):
            raw = path.read_text(encoding="utf-8-sig")
            entries = _entries(raw)
            if raw.strip() and raw.strip() != ENTRY_DELIMITER.join(entries):
                raise Unsupported(f"{path.name} was edited outside Hermes")
            kept = [e for e in entries if memory_id(e) != item_id]
            if len(kept) == len(entries):
                return False
            self._backup(path)
            _write_atomic(path, ENTRY_DELIMITER.join(kept))
        return True

    def fingerprint(self) -> Tuple:
        """What the report shows changed when this does (mtime and size of each file it reads)."""
        paths = [self.config_path, *(self.home / "memories" / n for n in MEMORY_FILES.values())]
        root = self.home / "skills"
        if root.exists():
            paths.extend(sorted(root.rglob("SKILL.md")))
        out = []
        for p in paths:
            try:
                st = p.stat()
                out.append((str(p), st.st_mtime_ns, st.st_size))
            except OSError:
                out.append((str(p), None, None))
        return tuple(out)

    def _backup(self, path: Path) -> None:
        """A copy named by its UTC time (sortable, unique even within one clock tick); the 5 newest stay."""
        self.backups.mkdir(parents=True, exist_ok=True)
        ns = time.time_ns()
        while True:
            seconds = time.strftime("%Y%m%dT%H%M%S", time.gmtime(ns // 1_000_000_000))
            target = self.backups / f"{path.name}.{seconds}{ns % 1_000_000_000:09d}"
            if not target.exists():
                break
            ns += 1
        shutil.copy2(path, target)
        for stale in sorted(self.backups.glob(f"{path.name}.*"))[:-BACKUPS_KEPT]:
            stale.unlink(missing_ok=True)


KeyCheck = Callable[[str, str], Awaitable[str]]
Request = Callable[[str, Dict[str, Any]], Awaitable[Any]]


async def check_key(provider: str, key: str, timeout: float = 10.0) -> str:
    """The provider's free listing with the key: 'ok', 'refused' or 'unreachable' (no tokens spent)."""
    import aiohttp
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(KEY_CHECK_URLS[provider], headers={"Authorization": f"Bearer {key}"}) as res:
                if res.status in (401, 403):
                    return "refused"
                return "ok" if res.status == 200 else "unreachable"
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return "unreachable"


async def restart_gateway_s6() -> None:
    """GHOSTLINK_COMPANY_RESTART=s6: for a Hermes that reads its config only at start. This process
    ends with it; GhostLink sends the keys again when the plugin reconnects."""
    proc = await asyncio.create_subprocess_exec("/command/s6-svc", "-r", "/run/service/gateway-default")
    await proc.wait()


class CompanyAgent:
    """The company Hermes's side of the protocol: applies `hermes.config`, deletes a memory item on
    `hermes.memory.delete`, sends `hermes.report` (at once, after the key checks, and when skills or
    memory change), and answers the adapter's access questions."""

    def __init__(self, home: CompanyHome, request: Request, check_key: KeyCheck = check_key,
                 restart: Optional[Callable[[], Awaitable[None]]] = None):
        self.home, self.request, self.check_key, self.restart = home, request, check_key, restart
        self.active = False  # a hermes.config arrived: this bot is the company Hermes
        self.version = 0
        self.access: Dict[str, Any] = {"roleIds": [], "channels": "all"}
        self.key_status = {p: "missing" for p in PROVIDER_ENV}
        self.unsupported: Optional[str] = None
        self._fingerprint: Optional[Tuple] = None

    async def on_event(self, t: str, d: Dict[str, Any]) -> bool:
        """True when the event was the company Hermes's (the adapter then stops there)."""
        if t == "hermes.config":
            await self._apply(d)
            return True
        if t == "hermes.memory.delete":
            try:
                await asyncio.to_thread(self.home.delete_memory, str(d.get("target")), str(d.get("id")))
            except (Unsupported, KeyError, OSError) as exc:
                logger.warning("GhostLink: memory item not deleted: %s", type(exc).__name__)
            await self.report()
            return True
        return False

    async def _apply(self, d: Dict[str, Any]) -> None:
        self.active = True
        keys = d.get("keys") or {}
        try:
            changed = await asyncio.to_thread(self.home.apply, d)
        except (Unsupported, OSError) as exc:
            self.unsupported = _fit(str(exc) or type(exc).__name__, REASON_MAX)
            logger.error("GhostLink: Hermes version not supported (%s); nothing applied", self.unsupported)
            await self.report()
            return
        self.unsupported = None
        self.version = int(d.get("version") or 0)
        self.access = d.get("access") or {"roleIds": [], "channels": "all"}
        for p in PROVIDER_ENV:
            if not keys.get(p):
                self.key_status[p] = "missing"
            elif p in changed["keys"] or self.key_status[p] == "missing":
                self.key_status[p] = "unchecked"
        await self.report()
        pending = [p for p in PROVIDER_ENV if self.key_status[p] == "unchecked"]
        if pending:
            results = await asyncio.gather(*(self.check_key(p, keys[p]) for p in pending))
            self.key_status.update(zip(pending, results))
            await self.report()
        if changed["config"] and self.restart is not None:
            await self.restart()

    def _build_report(self) -> Dict[str, Any]:
        primary = fallback = None
        skills: List[Dict[str, Any]] = []
        memory: Dict[str, List[Dict[str, str]]] = {"company": [], "people": []}
        if self.unsupported is None:
            try:
                primary, fallback = self.home.models()
                skills, memory = self.home.skills(), self.home.memory()
            except (Unsupported, OSError) as exc:
                self.unsupported = _fit(str(exc) or type(exc).__name__, REASON_MAX)
        self._fingerprint = self.home.fingerprint()
        return {"appliedVersion": self.version, "skills": skills, "memory": memory,
                "status": {"model": primary, "fallback": fallback, "keys": dict(self.key_status),
                           "unsupported": self.unsupported, "envOverride": self.home.env_override()}}

    async def report(self) -> None:
        payload = await asyncio.to_thread(self._build_report)
        try:
            await self.request("hermes.report", payload)
        except Exception as exc:  # the next change or reconnection reports again
            logger.warning("GhostLink: hermes.report failed (%s)", getattr(exc, "code", type(exc).__name__))

    async def watch(self, every: float = 60.0) -> None:
        """Reports again when Hermes itself changed a skill or its memory."""
        while True:
            await asyncio.sleep(every)
            if self.active and await asyncio.to_thread(self.home.fingerprint) != self._fingerprint:
                await self.report()

    # ---- access (spec §2 "Quem pode usar") ----

    def allows(self, user_id: str, owner_id: Optional[str], role_ids: List[str]) -> bool:
        if user_id and user_id == owner_id:
            return True
        return bool(set(self.access.get("roleIds") or []).intersection(role_ids))

    def listens_in(self, channel_id: str) -> bool:
        channels = self.access.get("channels", "all")
        return channels == "all" or channel_id in channels
```

- [ ] **Step 4: `reconnect_delay` and the slow retry in `client.py`**

```python
# Retrying soon cannot help, but it may later: this server is not Enterprise now (a renewal fixes it).
SLOW_RETRY = {"ENTERPRISE_REQUIRED": 120.0}
```

Add to `_EXPLAIN`:

```python
    "ENTERPRISE_REQUIRED": "this server is not Enterprise (its license lapsed): the company Hermes tries again every 2 minutes",
```

Add after `backoff_delay`:

```python
def reconnect_delay(cause: str, attempt: int, timing: Timing, rand: Callable[[], float] = random.random) -> float:
    """The backoff, or longer for codes only time fixes (SLOW_RETRY)."""
    return max(backoff_delay(attempt, timing, rand), SLOW_RETRY.get(cause, 0.0))
```

and in `_run` replace `delay = backoff_delay(failures, self._timing)` with `delay = reconnect_delay(cause, failures, self._timing)`. Set `CLIENT_NAME = "hermes-ghostlink/1.1"`.

- [ ] **Step 5: Run the check**

Run: `npm test -- integrations/hermes-agent/test/company.test.ts integrations/hermes-agent/test/ghostlink-client.test.ts`
Expected: PASS (or SKIPPED without the Python packages; CI runs them, Task D3).

- [ ] **Step 6: Commit**

```bash
git add integrations/hermes-agent/ghostlink/company.py integrations/hermes-agent/ghostlink/client.py integrations/hermes-agent/test/company_check.py integrations/hermes-agent/test/company.test.ts
git commit -m "feat(hermes-plugin): apply the company Hermes's config, keys only in memory, and report back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D2: The adapter uses it

**Files:** Modify `integrations/hermes-agent/ghostlink/adapter.py`, `integrations/hermes-agent/ghostlink/plugin.yaml`, `integrations/hermes-agent/README.md`.

- [ ] **Step 1: Wire `CompanyAgent` into the adapter**

Add `import asyncio`, `import os` and `from pathlib import Path` to the adapter's imports, then:

```python
from .company import CompanyAgent, CompanyHome, check_key, restart_gateway_s6


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
```

- `__init__`: `self._company: Optional[CompanyAgent] = None` and `self._company_watch: Optional[asyncio.Task] = None`.
- `connect`, **before** `client.start()` (the first `hermes.config` arrives right after the welcome):

```python
        self._company = CompanyAgent(
            CompanyHome(_hermes_home()), request=lambda t, d: client.request(t, d), check_key=check_key,
            restart=restart_gateway_s6 if os.environ.get("GHOSTLINK_COMPANY_RESTART") == "s6" else None)
```

  and after a successful start: `self._company_watch = asyncio.create_task(self._company.watch(), name="ghostlink-company")`. A `GhostLinkError` with code `ENTERPRISE_REQUIRED` at start sets `self._set_fatal_error("ghostlink_enterprise_required", str(exc), retryable=True)` (not fatal for good).
- `disconnect`: cancel `_company_watch`.
- `_on_event`: first line `if self._company is not None and await self._company.on_event(t, d): return`.
- `_role_authorized`: first lines

```python
        company = self._company
        if company is not None and company.active:
            return company.allows(user_id, self._owner_id, list((self._members.get(user_id) or {}).get("roleIds") or []))
```

- `_addressed`: first lines

```python
        company = self._company
        if company is not None and company.active:  # spec §2: only when mentioned or replied to
            return addressed and company.listens_in(channel_id)
```

- [ ] **Step 2: Manifest and README**

`plugin.yaml`: `version: 1.1.0`, the description gains "In an Enterprise GhostLink server, the bot marked as the company Hermes gets its settings and AI keys from GhostLink.", and `optional_env` gains:

```yaml
  - name: GHOSTLINK_COMPANY_RESTART
    description: "s6: restart Hermes's gateway after a model change (only for a Hermes that reads config.yaml at start)"
    prompt: "Restart after changes? (s6 or empty)"
    password: false
```

`README.md`, a new section **"Hermes da empresa (servidor Enterprise)"** (pt-BR): what GhostLink sends and where it lands (the table "Onde grava" from the decisions above: keys only in memory, models and skills in `config.yaml`, roles and channels in the plugin, backups in `$HERMES_HOME/ghostlink/backups`), that a key in Hermes's `.env` wins (remove it), `GHOSTLINK_COMPANY_RESTART`, and that the panel's changes reach a disconnected Hermes when it reconnects. No key or code examples with real-looking values.

- [ ] **Step 3: Run the plugin tests, commit**

Run: `npm test -- integrations/hermes-agent`
Expected: PASS (or SKIPPED locally without the packages). If a Hermes install is at hand, also `python integrations/hermes-agent/test/adapter_check.py integrations/hermes-agent/ghostlink` → `ok` (the legacy, non-company behaviour is unchanged).

```bash
git add integrations/hermes-agent/ghostlink/adapter.py integrations/hermes-agent/ghostlink/plugin.yaml integrations/hermes-agent/README.md
git commit -m "feat(hermes-plugin): the company Hermes's access rules and reports in the GhostLink adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D3: CI runs the plugin's Python tests

**Files:** Modify `.github/workflows/ci.yml`, `scripts/test/ciWorkflow.test.ts`.

- [ ] **Step 1: The failing policy test**

In `scripts/test/ciWorkflow.test.ts`:

```ts
  it('gives the Hermes plugin tests a Python with its packages pinned as Hermes pins them (Linux)', () => {
    const test = workflow.jobs.test!;
    const index = test.steps.findIndex((s) => s.name === 'Python for the Hermes plugin tests');
    expect(index).toBeGreaterThan(0);
    const step = test.steps[index]!;
    expect(step.if).toBe("runner.os == 'Linux'");
    expect(step.run).toMatch(/aiohttp==3\.14\.3 cryptography==50\.0\.1 ruamel\.yaml==0\.18\.16/);
    expect(step.run).toMatch(/GHOSTLINK_TEST_PYTHON=.*>> "\$GITHUB_ENV"/);
    expect(index).toBeLessThan(runIndex(test, 'npm test'));
  });
```

Run: `npm test -- scripts/test/ciWorkflow.test.ts` → FAIL.

- [ ] **Step 2: The step**

`.github/workflows/ci.yml`, in `test`, right before `- name: Unit and integration tests`:

```yaml
      # The Hermes plugin's tests (integrations/hermes-agent) need Python with the plugin's packages,
      # pinned as Hermes Agent pins them. Linux only: elsewhere they skip.
      - name: Python for the Hermes plugin tests
        if: runner.os == 'Linux'
        run: |
          python3 -m venv "$RUNNER_TEMP/hermes-py"
          "$RUNNER_TEMP/hermes-py/bin/pip" install --disable-pip-version-check aiohttp==3.14.3 cryptography==50.0.1 ruamel.yaml==0.18.16
          echo "GHOSTLINK_TEST_PYTHON=$RUNNER_TEMP/hermes-py/bin/python" >> "$GITHUB_ENV"
```

- [ ] **Step 3: Run, commit**

Run: `npm test -- scripts/test/ciWorkflow.test.ts`
Expected: PASS.

```bash
git add .github/workflows/ci.yml scripts/test/ciWorkflow.test.ts
git commit -m "ci: run the Hermes plugin's Python tests on Linux

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Integration (main session, after Tracks A–D)

### Task I1: End to end — a real server and the plugin's real code (spec §6 "Ponta a ponta")

**Files:** Create `integrations/hermes-agent/test/company_e2e.py`, `integrations/hermes-agent/test/company-hermes.test.ts`.

- [ ] **Step 1: The Python side**

`integrations/hermes-agent/test/company_e2e.py`:

```python
"""Runs the company Hermes's plugin code (client.py + company.py) against a GhostLink server for
company-hermes.test.ts, on a scratch HERMES_HOME. Key checks are faked (no network beyond the server).
Prints one JSON line per step; never prints a key."""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import GhostLinkBotClient, parse_connection_code  # noqa: E402
from company import PROVIDER_ENV, CompanyAgent, CompanyHome  # noqa: E402


def say(**fields):
    print(json.dumps(fields), flush=True)


async def fake_check(provider, key):
    return "ok" if key.startswith("sk-test-ok-") else "refused"


async def main() -> None:
    box = {}

    async def on_event(t, d):
        if await box["agent"].on_event(t, d):
            say(event=t, version=box["agent"].version, env={v: v in os.environ for v in PROVIDER_ENV.values()})

    client = GhostLinkBotClient(parse_connection_code(os.environ["GHOSTLINK_BOT"]), on_event=on_event, on_welcome=lambda w: None)
    box["agent"] = CompanyAgent(CompanyHome(Path(os.environ["HERMES_HOME"])), request=lambda t, d: client.request(t, d), check_key=fake_check)
    await client.start()
    say(ready=True)
    await asyncio.Event().wait()  # until the test kills it


asyncio.run(main())
```

- [ ] **Step 2: The test**

`integrations/hermes-agent/test/company-hermes.test.ts`:

```ts
// The company Hermes end to end (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §6): a real
// server with the enterprise and companyHermes modules, the plugin's own code (company_e2e.py) on a
// scratch HERMES_HOME, and the owner's requests exactly as the app sends them. Skipped without Python
// with aiohttp, cryptography and ruamel.yaml (CI's Linux job has them).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotCreateResult, HermesState } from '@ghostlink/shared';
import { createAvatarsModule } from '../../../apps/server/src/avatars/index.js';
import { createBotsModule } from '../../../apps/server/src/bots/index.js';
import { createCompanyHermesModule } from '../../../apps/server/src/companyHermes/index.js';
import { createEnterpriseModule } from '../../../apps/server/src/enterprise/index.js';
import { testLicenseKey } from '../../../apps/server/test/helpers/license.js';
import { textFixture } from '../../../apps/server/test/text/helpers.js';

const SCRIPT = fileURLToPath(new URL('./company_e2e.py', import.meta.url));
const DAY = 86_400_000;

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, cryptography, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ghostlink-hermes-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.yaml'), '# TC Hermes (teste)\nmodel:\n  provider: deepseek\n  default: deepseek-v4-pro\nfallback_model:\n  provider: openrouter\n  model: deepseek/deepseek-v4-pro\n');
  for (const [dir, name] of [['hermes-agent', 'hermes-agent'], ['geral/resumo', 'resumo']] as const) {
    mkdirSync(join(home, 'skills', dir), { recursive: true });
    writeFileSync(join(home, 'skills', dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Uma skill\n---\n`);
  }
  mkdirSync(join(home, 'memories'));
  writeFileSync(join(home, 'memories', 'MEMORY.md'), 'A TC Flag fabrica bandeiras.\n§\nO estoque fica em Guarulhos.');
  return home;
}

function runHermes(code: string, home: string) {
  const child: ChildProcess = spawn(PYTHON!, [SCRIPT], { env: { ...process.env, GHOSTLINK_BOT: code, HERMES_HOME: home, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' } });
  cleanups.push(() => child.kill());
  let stderr = '';
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()));
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  // Every line stays: "ready" and the first hermes.config may arrive in either order.
  const seen: Record<string, unknown>[] = [];
  return {
    async until(pred: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const earlier = seen.find(pred);
      if (earlier) return earlier;
      for (;;) {
        const next = await lines.next();
        if (next.done) throw new Error(`company_e2e.py ended:\n${stderr}`);
        const line = JSON.parse(next.value) as Record<string, unknown>;
        seen.push(line);
        if (pred(line)) return line;
      }
    },
  };
}

describe.skipIf(PYTHON === null)('the company Hermes, end to end (spec §6)', () => {
  it('the owner changes the model and a key; the Hermes applies them and the panel shows it; a memory item goes', async () => {
    const key = testLicenseKey();
    const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule(), createEnterpriseModule({ publicKey: key.publicKey }), createCompanyHermesModule()] });
    await fx.owner.ok('enterprise.license.set', {
      license: key.issue({ company: 'TC Flag', serverKeyId: fx.t.server.serverKeyId, issuedAt: fx.clock.now, expiresAt: fx.clock.now + 365 * DAY }),
    });
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const home = scratchHome();
    const hermes = runHermes(created.connectionToken, home);
    await hermes.until((l) => l.ready === true);
    await hermes.until((l) => l.event === 'hermes.config');
    const first = await fx.owner.event<HermesState>('hermes.state', (s) => s.report !== null, 15_000);
    expect(first.report!.skills.map((s) => s.name)).toEqual(['hermes-agent', 'resumo']);

    const aiKey = `sk-test-ok-${randomBytes(12).toString('hex')}`; // fake, made now
    await fx.owner.ok('hermes.update', { keys: { deepseek: aiKey }, models: { primary: { provider: 'deepseek', model: 'deepseek-flash' }, fallback: null } });
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 1)).toMatchObject({ env: { DEEPSEEK_API_KEY: true, OPENROUTER_API_KEY: false } });
    const applied = await fx.owner.event<HermesState>('hermes.state', (s) => s.report?.appliedVersion === 1 && s.report.status.keys.deepseek === 'ok', 15_000);
    expect(applied.report!.status.model).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });

    const config = readFileSync(join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('# TC Hermes (teste)');
    expect(config).toContain('default: deepseek-flash');
    expect(config).not.toContain('fallback_model');
    for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain(aiKey);
    }
    expect(JSON.stringify(fx.owner.events)).not.toContain(aiKey);

    const stock = applied.report!.memory.company.find((m) => m.text === 'O estoque fica em Guarulhos.')!;
    await fx.owner.ok('hermes.memory.delete', { target: 'company', id: stock.id });
    await fx.owner.event<HermesState>('hermes.state', (s) => s.report?.memory.company.length === 1, 15_000);
    expect(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8')).toBe('A TC Flag fabrica bandeiras.');
  });
});
```

- [ ] **Step 3: Run it**

Run: `npm test -- integrations/hermes-agent/test/company-hermes.test.ts`
Expected: PASS (with the Python packages; otherwise SKIPPED and CI runs it).

- [ ] **Step 4: Commit**

```bash
git add integrations/hermes-agent/test/company_e2e.py integrations/hermes-agent/test/company-hermes.test.ts
git commit -m "test(hermes-plugin): the company Hermes end to end, real server and the plugin's own code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task I2: Docs, checklist, release notes, version

- [ ] **Step 1: `apps/server/src/MODULES.md`**

- Migrations: "`009_enterprise.sql` adds `enterprise` (the license and the edition) and `company_hermes` (the company Hermes's bot, keys, settings and last report)".
- A section **Enterprise** (`src/enterprise/`, registered after bots): the license (`GLE1.<data>.<signature>`, the license key in `LICENSE_PUBLIC_KEY`, `scripts/gen-license-key.mjs` / `issue-license.mjs` on the owner's PC only), checked at paste, start and hourly; `edition` mirrored in `enterprise.edition` for the bot handshake; `onChange` listeners; the Ghost DJ parks itself (`SystemBot.setHidden`, `BotTextApi.park/unpark`).
- A section **The company Hermes** (`src/companyHermes/`, after enterprise): `hermes.*` requests, `hermes.config` only to its session, keys never in answers or logs, `bot.regenerate` / `bot.delete` owner-only for it, `auth/botAuth.ts` refusing it on a normal server.
- Deleting the server: both tables are emptied by `eraseDatabase` (nothing to add to `eraseFiles`).

- [ ] **Step 2: `docs/checklist-teste.md`** — a "v0.6.0 Enterprise" block: paste a license and see the badge for everyone; the DJ disappears and comes back; create the Hermes da empresa; save a key (only the last 4 show) and change the model; see "Conectado" and the model in use; switch a skill; restrict to a role; delete a memory item; Hermes offline shows the last lists with "Hermes desconectado".

- [ ] **Step 3: `release-notes/0.6.0.md`** (pt-BR first, then English, as `release-notes/0.5.1.md`): **Servidores Enterprise** (licença, selo, sem Ghost DJ), **Hermes da empresa** (as cinco abas e a situação), servers update themselves; the Hermes plugin 1.1 needs no `.env` keys.

- [ ] **Step 4: Version 0.6.0** — the same files as the `release: 0.5.1` commit (`package.json` ×5, `package-lock.json`, `docs-site/verificar-downloads.md`, `docs-site/en/verify-downloads.md`) — **only after the owner approves the release**.

- [ ] **Step 5: Check the ceremony ran** — `packages/shared/src/license.ts` has a 43-character `LICENSE_PUBLIC_KEY` (Task A1 Step 8). Without it no license can ever be valid: do not release.

- [ ] **Step 6: Commit, push, CI**

```bash
git add apps/server/src/MODULES.md docs/checklist-teste.md release-notes/0.6.0.md
git commit -m "docs: Enterprise servers and the company Hermes (v0.6.0)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin v0.6.0-dev
```

Open the PR; CI (Windows, Linux with the Python tests, macOS, package, image) is the gate. The owner approves the release (tag `v0.6.0`).

---

## Task R: Create the TC Hermes (spec §4) — main session **with the owner**, after v0.6.0 is published

Not code. Every step is done or approved live by the owner. Never print or paste a key, a token, a connection code or a `.env`; secrets go only into the Railway dashboard's Variables by the owner, or into GhostLink's panel. Reading the Trismegisto is **read-only** and only with the owner's go-ahead.

- [ ] **R1. Preconditions:** the TC Flag GhostLink server (Railway project **ghostlink-tc-flag**) runs 0.6.0 (the owner's app updated it); the owner has the license key on their PC.
- [ ] **R2. License:** the owner opens TC Flag → Configurações do servidor → **Enterprise**, copies "Identidade do servidor"; on the owner's PC: `node scripts/issue-license.mjs --key "D:\GhostLink Licencas\ghostlink-license-key.pem" --company "TC Flag" --server <identity> --until <date the owner picks>`; the owner pastes the license; the badge **Enterprise** appears and the Ghost DJ leaves.
- [ ] **R3. Image:** read the Trismegisto's pinned image digest (Railway dashboard → service → Settings → Source; or `railway status` in that project). The TC Hermes uses `nousresearch/hermes-agent@sha256:<that digest>`.
- [ ] **R4. Service:** in **ghostlink-tc-flag**, create the service **"TC Hermes"** from that image; a volume at `/data`; 2 vCPU / 2 GB; **no public domain** (do not generate one); variable `HERMES_HOME=/data`. (`railway add` / `railway volume add --mount-path /data` where the CLI has them, the dashboard otherwise.)
- [ ] **R5. Only GhostLink:** copy `integrations/hermes-agent/ghostlink/` **at tag `v0.6.0`** into `/data/plugins/ghostlink/` (e.g. through `railway ssh`, fetching `__init__.py`, `adapter.py`, `client.py`, `company.py` and `plugin.yaml` from `https://raw.githubusercontent.com/gestao-in7eligente/ghostlink/v0.6.0/integrations/hermes-agent/ghostlink/`, and comparing each `sha256sum` there with `git show v0.6.0:integrations/hermes-agent/ghostlink/<file> | sha256sum` run locally); `config.yaml` with `plugins.enabled: [ghostlink]`, the model defaults (`model.provider: deepseek`, `model.default: deepseek-v4-pro`, the reserve `openrouter` / `deepseek/deepseek-v4-pro`), Discord and every other platform off, the API server off.
- [ ] **R6. Start command:** copy the Trismegisto's, keeping patch #15 **with the same version guard**, without the Discord patch.
- [ ] **R7. Generic skills:** list the Trismegisto's 46 active skills (name, description, and a scan of each `SKILL.md` for keys, tokens and internal addresses) without changing anything there; Claude classifies them **generic vs. Macrol-specific** in a table; **the owner approves the list**; copy only the approved ones into `/data/skills/`, cleaning or leaving out any with a key, token or internal address.
- [ ] **R8. Clean start:** no `memories/`, no sessions, no `.env` keys (the AI keys come only from GhostLink); `SOUL.md` written with the owner ("TC Hermes, assistente da TC Flag").
- [ ] **R9. Activation:** the owner opens "Adicionar bot" → **Hermes da empresa** (name "TC Hermes") and copies the code; **the owner** pastes it into the TC Hermes's `GHOSTLINK_BOT` variable in the Railway dashboard; redeploy. In the bot's settings the situation shows **Conectado** and the skills list.
- [ ] **R10. Verify on the pinned digest** (the two facts this plan relies on): the TC Flag pastes its own keys in **Chaves de IA** (the owner, not Claude); "A DeepSeek recusou a chave" does not appear; change the model in **Modelos** and ask the Hermes something — the answer comes from the new model without a restart. If it does not, set `GHOSTLINK_COMPANY_RESTART=s6` on the TC Hermes and repeat. Also confirm the gateway starts with no keys and that a restart brings the keys back within seconds (the panel shows the key test as "ok" again).
- [ ] **R11. Hand-off:** the owner sees the five tabs working; record in the memory notes what was created (service name, digest, plugin version), never any secret.
