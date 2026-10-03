// The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2, §3): one
// bot per Enterprise server, marked by the server, which gets the company's settings and AI keys
// through its pinned bot session. Payloads, events, strict server schemas, lenient client schemas.
//
// Owner requests (FORBIDDEN for anyone else; changes need an Enterprise server: ENTERPRISE_REQUIRED):
//   - `hermes.create { name }` → BotCreateResult: a bot marked as the company Hermes, one per
//     server (BAD_REQUEST when it exists); its connection code shows once, as for any bot.
//   - `hermes.get {}` → HermesState (on a normal server too, with `locked`).
//   - `hermes.update { keys?, models?, disabledSkills?, access?, viewerRoleId? }` → HermesState.
//     `viewerRoleId` (v0.6.2, `enterpriseHermesView`): a role of the server, not @everyone (NOT_FOUND,
//     BAD_REQUEST), or null; GhostLink's alone, never in `hermes.config`.
//   - `hermes.memory.delete { target, id }` → {} (BOT_OFFLINE while the Hermes is disconnected).
// To the company Hermes's session only: `hermes.config` (HermesConfig, keys included) when it
//   connects and after every change; `hermes.memory.delete` (HermesMemoryDelete).
// From the company Hermes only: `hermes.report` (HermesReport) → {}.
// To the owner's sessions: `hermes.state` (HermesState); the owner's welcome carries `hermes`.
//
// The company Hermes's page (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md, `enterpriseHermesView`):
//   - `hermes.view {}` → { view: HermesView }: the owner, and the viewer role's members while the
//     server is Enterprise; FORBIDDEN for anyone else.
//   - Event `hermes.view { view: HermesView | null }` to exactly those people when what they see
//     changes; `view: null` to whoever just lost it (the role taken away or deleted, a lapse, a transfer).
//   - Their welcome carries `hermesView`, so the app knows which bot is the company Hermes.
//   The role's view never has the keys (not even their last 4), the memory nor its counts.
// Only the owner may regenerate the company Hermes's code or delete it (bot.regenerate / bot.delete).
//
// The API tab (spec 2026-10-03-aba-api-e-sites-design.md §1, `enterpriseApis`, v0.7.0):
//   - `hermes.update` takes `keys` for the five AI providers and `apis`: any other API key by its
//     environment variable (the catalog's, or one of the owner's own named after apiEnvVarProblem's
//     rules), `null` to delete it; at most 30 keys in all.
//   - `hermes.config` carries `keys` (the five), `apis` ({ VAR: key }) and `sites` (sites.ts). Plugin 1.1
//     reads only keys.deepseek / keys.openrouter and ignores the rest.
//   - HermesState shows each as its last 4: `keys` by provider, `apis` for the others.
import { z } from 'zod';
import { entityIdSchema } from './chat.js';
import type { HermesSite } from './sites.js';

export const FEATURE_ENTERPRISE_HERMES = 'enterpriseHermes';
/** welcome.features (v0.6.2): the company Hermes's page, for the owner and a chosen role. */
export const FEATURE_ENTERPRISE_HERMES_VIEW = 'enterpriseHermesView';
/** welcome.features (v0.7.0): the API tab (`apis` in hermes.update, the five AI providers). */
export const FEATURE_ENTERPRISE_APIS = 'enterpriseApis';

/** The AI providers GhostLink keeps keys for, by the id Hermes's `model.provider` takes (plan "Facts" 1). */
export const HERMES_PROVIDERS = ['deepseek', 'openrouter', 'openai-api', 'anthropic', 'gemini'] as const;
export type HermesProvider = (typeof HERMES_PROVIDERS)[number];
/** The two a plugin 1.1 knows: its report's `status.keys` has only these. */
export const HERMES_PROVIDERS_V1 = ['deepseek', 'openrouter'] as const satisfies readonly HermesProvider[];

export const HERMES_LIMITS = {
  keyMax: 512,
  /** API keys in all, the five AIs' included (spec 2026-10-03 §1 "Limite"). */
  maxApis: 30,
  /** An "Outra API" display name, in graphemes. */
  apiNameMax: 64,
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

/** The variable Hermes reads each AI provider's key from (plan "Facts" 1). */
export const HERMES_PROVIDER_ENV: Readonly<Record<HermesProvider, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-api': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export const HERMES_PROVIDER_NAMES: Readonly<Record<HermesProvider, string>> = {
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  'openai-api': 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

/** An API of the API tab's catalog. */
export interface HermesApiCatalogEntry {
  envVar: string;
  name: string;
  /** The AI provider it keys (Models tab, key test); null: another API, never tested. */
  provider: HermesProvider | null;
}

/**
 * Spec §1 "Catálogo": the AIs, then the others (their variables are what the TC Hermes's skills read).
 * MACROL_MCP_KEY is not here: Hermes connects MCP servers before GhostLink sends any key (plan decision 16).
 */
export const HERMES_API_CATALOG: readonly HermesApiCatalogEntry[] = [
  ...HERMES_PROVIDERS.map((provider) => ({ envVar: HERMES_PROVIDER_ENV[provider], name: HERMES_PROVIDER_NAMES[provider], provider })),
  { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', provider: null },
  { envVar: 'GROK_API_KEY', name: 'Grok (xAI)', provider: null },
  { envVar: 'YUNWU_API_KEY', name: 'Yunwu', provider: null },
];

/** "Outra API": a letter, then letters, digits and `_`; 3 to 64 in all (a variable cannot start with a digit). */
export const API_ENV_VAR = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Variables an API key must never replace (spec §1 "Nomes recusados"): the system's, the Python and
 * Node runtimes', TLS and proxies, Hermes's and GhostLink's. integrations/hermes-agent/ghostlink/company.py
 * keeps the same two lists (ENV_DENIED_NAMES / ENV_DENIED_PREFIXES): change both together.
 */
export const API_ENV_DENIED_NAMES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TERM', 'TZ',
  'HOSTNAME', 'LOGNAME', 'MAIL', 'IFS', 'ENV', 'CDPATH', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'EDITOR', 'VISUAL',
  'PAGER', 'DISPLAY', 'SSH_AUTH_SOCK', 'VIRTUAL_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY',
];
export const API_ENV_DENIED_PREFIXES: readonly string[] = [
  'LD_', 'DYLD_', 'PYTHON', 'NODE_', 'NPM_', 'SSL_', 'REQUESTS_CA', 'CURL_CA', 'GIT_', 'PIP_', 'UV_', 'LC_', 'XDG_',
  // Hermes reads its terminal backend (TERMINAL_*) and the gateway's allowlists (GATEWAY_*) from the environment.
  'BASH_', 'S6_', 'RAILWAY_', 'TERMINAL_', 'GATEWAY_', 'HERMES_', 'GHOSTLINK_',
];

export type ApiEnvVarProblem = 'format' | 'reserved' | 'catalog';

/** Why a variable cannot be an "Outra API" (null: it can). 'catalog': it has its own row. */
export function apiEnvVarProblem(envVar: string): ApiEnvVarProblem | null {
  if (!API_ENV_VAR.test(envVar)) return 'format';
  if (API_ENV_DENIED_NAMES.includes(envVar) || API_ENV_DENIED_PREFIXES.some((p) => envVar.startsWith(p))) return 'reserved';
  if (HERMES_API_CATALOG.some((a) => a.envVar === envVar)) return 'catalog';
  return null;
}

/** `hermes.config`: everything the Hermes should be, keys included. A secret: never logged. */
export interface HermesConfig extends HermesSettings {
  /** Bumped by every hermes.update and every site change; the report names the one applied. */
  version: number;
  /** The AI keys by provider (plugin 1.1 reads deepseek and openrouter only). */
  keys: Record<HermesProvider, string | null>;
  /** v0.7.0: every other API key, by its environment variable. */
  apis: Record<string, string>;
  /** v0.7.0: the company's sites (no key). */
  sites: HermesSite[];
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

/** An API key other than the five AIs', as the owner's app sees it (v0.7.0). */
export interface HermesApiInfo {
  envVar: string;
  name: string;
  last4: string;
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
  /** v0.7.0: the other API keys saved, by variable, each as its last 4 ([] from a server before 0.7.0). */
  apis: HermesApiInfo[];
  settings: HermesSettings;
  version: number;
  /** The last report, kept while it is disconnected. */
  report: HermesReport | null;
  reportAt: number | null;
  /** The role whose members see the company Hermes's page (v0.6.2); null: the owner alone. Never sent to the Hermes. */
  viewerRoleId: string | null;
}

/** A skill switched on, as the page shows it. */
export interface HermesViewSkill {
  name: string;
  description: string;
}

/**
 * The company Hermes's page (spec 2026-10-03 §2): what the owner and the viewer role see. Access
 * lists only roles and channels that still exist, and for a role holder only the channels that
 * person can see (`hiddenChannels` counts the rest). `memory` is the owner's alone.
 */
export interface HermesView {
  botId: string | null;
  connected: boolean;
  /** As configured. */
  models: HermesSettings['models'];
  /** The model the Hermes reported in use; null before a report. */
  modelInUse: HermesModelInUse | null;
  /** The skills switched on, from the last report; null: the Hermes never reported. */
  skills: HermesViewSkill[] | null;
  access: HermesAccess;
  /** Chosen channels this person cannot see: counted, never named (0 for the owner and for 'all'). */
  hiddenChannels: number;
  /** The owner's view only: how many items it keeps (never their text); null before a report. */
  memory?: { company: number; people: number } | null;
}

export interface HermesUpdatePayload {
  /** A key, or null to delete it; absent: unchanged. */
  keys?: Partial<Record<HermesProvider, string | null>>;
  /** v0.7.0: other API keys by variable: a key (and, for a variable of the owner's own, its name), or null to delete. */
  apis?: Record<string, { name?: string; value: string } | null>;
  models?: HermesSettings['models'];
  disabledSkills?: string[];
  access?: HermesAccess;
  /** v0.6.2: the role that sees the page, or null for none. */
  viewerRoleId?: string | null;
}

// ---- server side: strict ----

const provider = z.enum(HERMES_PROVIDERS);
const modelName = z.string().regex(/^[A-Za-z0-9._:/@-]{1,128}$/);
const modelRef = z.strictObject({ provider, model: modelName });
/** Printable ASCII without spaces; a pasted key's surrounding spaces are dropped. */
const keyValue = z.string().trim().regex(/^[\x21-\x7e]{8,512}$/);
const skillName = z.string().min(1).max(HERMES_LIMITS.skillNameMax).refine((v) => ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f));
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
const keyChange = keyValue.nullable().optional();
const apiEnvVar = z.string().regex(API_ENV_VAR);
const apiName = z.string().min(1).max(256); // cut to HERMES_LIMITS.apiNameMax graphemes by the server

export const hermesUpdateSchema = z
  .strictObject({
    keys: z.strictObject({ deepseek: keyChange, openrouter: keyChange, 'openai-api': keyChange, anthropic: keyChange, gemini: keyChange }).optional(),
    apis: z
      .record(apiEnvVar, z.strictObject({ name: apiName.optional(), value: keyValue }).nullable())
      .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= HERMES_LIMITS.maxApis, '1 to 30 changes')
      .optional(),
    models: hermesModelsSchema.optional(),
    disabledSkills: z.array(skillName).max(HERMES_LIMITS.maxSkills).optional(),
    access: hermesAccessSchema.optional(),
    viewerRoleId: entityIdSchema.nullable().optional(),
  })
  .refine(
    (p) =>
      p.keys !== undefined || p.apis !== undefined || p.models !== undefined || p.disabledSkills !== undefined || p.access !== undefined || p.viewerRoleId !== undefined,
    'nothing to update',
  );
export const hermesMemoryDeleteSchema = z.strictObject({ target: memoryTarget, id: memoryId });
export const hermesViewGetSchema = z.strictObject({});

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
    // Plugin 1.1 reports the first two only (decision 6).
    keys: z.strictObject({
      deepseek: keyStatus,
      openrouter: keyStatus,
      'openai-api': keyStatus.default('unchecked'),
      anthropic: keyStatus.default('unchecked'),
      gemini: keyStatus.default('unchecked'),
    }),
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
const modelsClient = z.object({ primary: modelRefClient, fallback: modelRefClient.nullable().catch(null) }).catch(HERMES_DEFAULT_SETTINGS.models);
const accessClient = z
  .object({
    roleIds: z.array(z.string().max(64)).max(1_000).catch([]),
    channels: z.union([z.literal('all'), z.array(z.string().max(64)).max(1_000)]).catch('all'),
  })
  .catch(HERMES_DEFAULT_SETTINGS.access);

const UNCHECKED_KEYS = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, 'unchecked'])) as Record<HermesProvider, HermesKeyStatus>;
const NO_KEYS = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, null])) as Record<HermesProvider, null>;

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
      keys: z
        .object({ deepseek: keyStatusClient, openrouter: keyStatusClient, 'openai-api': keyStatusClient, anthropic: keyStatusClient, gemini: keyStatusClient })
        .catch(UNCHECKED_KEYS),
      unsupported: z.string().max(400).nullable().catch(null),
      envOverride: z.array(z.enum(HERMES_PROVIDERS)).max(HERMES_PROVIDERS.length).catch([]),
    })
    .catch({ model: null, fallback: null, keys: UNCHECKED_KEYS, unsupported: null, envOverride: [] }),
});

export const hermesStateSchemaClient: z.ZodType<HermesState> = z.object({
  botId: z.string().max(64).nullable().catch(null),
  connected: z.boolean().catch(false),
  locked: z.boolean().catch(true),
  keys: z.object({ deepseek: lastFour, openrouter: lastFour, 'openai-api': lastFour, anthropic: lastFour, gemini: lastFour }).catch(NO_KEYS),
  // A server before 0.7.0 has none.
  apis: z.array(z.object({ envVar: z.string().max(64), name: z.string().max(256), last4: z.string().max(8) })).max(200).catch([]),
  settings: z
    .object({
      models: modelsClient,
      disabledSkills: z.array(z.string().max(256)).max(1_000).nullable().catch(null),
      access: accessClient,
    })
    .catch(HERMES_DEFAULT_SETTINGS),
  version: z.number().int().nonnegative().catch(0),
  report: hermesReportSchemaClient.nullable().catch(null),
  reportAt: z.number().nullable().catch(null),
  // A server before 0.6.2 has none: the owner alone.
  viewerRoleId: z.string().max(64).nullable().catch(null),
});

const count = z.number().int().nonnegative().catch(0);

export const hermesViewSchemaClient: z.ZodType<HermesView> = z.object({
  botId: z.string().max(64).nullable().catch(null),
  connected: z.boolean().catch(false),
  models: modelsClient,
  modelInUse: modelInUseClient,
  skills: z
    .array(z.object({ name: z.string().max(256), description: z.string().max(1_000).catch('') }))
    .max(1_000)
    .nullable()
    .catch(null),
  access: accessClient,
  hiddenChannels: count,
  memory: z.object({ company: count, people: count }).nullable().optional().catch(undefined),
});

/** The `hermes.view` event; `view: null`: this person no longer sees the page. */
export const hermesViewEventSchemaClient = z.object({ view: hermesViewSchemaClient.nullable() });
