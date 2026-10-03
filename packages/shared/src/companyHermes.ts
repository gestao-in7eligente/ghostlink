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
