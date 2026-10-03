import {
  HERMES_API_CATALOG,
  HERMES_DEFAULT_SETTINGS,
  HERMES_PROVIDERS,
  HERMES_PROVIDER_ENV,
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
  settings: string;
  version: number;
  report: string | null;
  report_at: number | null;
  viewer_role_id: string | null;
}

/** A key other than the five AIs' (v0.7.0), by the variable the plugin sets. */
export interface HermesApiRecord {
  envVar: string;
  name: string;
  /** A secret: only for hermes.config. */
  value: string;
}

export interface HermesRecord {
  botId: string | null;
  /** Secrets: only for hermes.config, never for an answer or a log. */
  keys: Record<HermesProvider, string | null>;
  /** v0.7.0: the other API keys (secrets too), by variable. */
  apis: HermesApiRecord[];
  settings: HermesSettings;
  version: number;
  report: HermesReport | null;
  reportAt: number | null;
  /** The role that sees the company Hermes's page (010_hermes_viewer_role.sql); never in hermes.config. */
  viewerRoleId: string | null;
}

/** An `apis` change already checked (companyHermes/apis.ts): a name and a key, or null to delete. */
export type HermesApisChange = Record<string, { name: string; value: string } | null>;

export interface HermesStoreChange extends Pick<HermesUpdatePayload, 'keys' | 'models' | 'disabledSkills' | 'access'> {
  apis?: HermesApisChange;
}

const PROVIDER_BY_ENV = new Map<string, HermesProvider>(HERMES_PROVIDERS.map((p) => [HERMES_PROVIDER_ENV[p], p]));
const catalogName = (envVar: string): string => HERMES_API_CATALOG.find((a) => a.envVar === envVar)?.name ?? envVar;

function json(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The single company_hermes row (009_enterprise.sql) and its keys (011_apis_and_sites.sql), read fresh each time. */
export class HermesStore {
  constructor(private readonly db: Db) {
    db.run('INSERT OR IGNORE INTO company_hermes (id) VALUES (1)');
  }

  load(): HermesRecord {
    const r = this.db.get<Row>('SELECT bot_id, settings, version, report, report_at, viewer_role_id FROM company_hermes WHERE id = 1')!;
    const keys = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, null])) as Record<HermesProvider, string | null>;
    const apis: HermesApiRecord[] = [];
    for (const k of this.db.all<{ env_var: string; name: string; value: string }>('SELECT env_var, name, value FROM company_hermes_keys ORDER BY env_var')) {
      const provider = PROVIDER_BY_ENV.get(k.env_var);
      if (provider) keys[provider] = k.value;
      else apis.push({ envVar: k.env_var, name: k.name, value: k.value });
    }
    const settings = hermesSettingsSchema.safeParse(json(r.settings));
    const report = hermesReportSchema.safeParse(json(r.report));
    return {
      botId: r.bot_id,
      keys,
      apis,
      settings: settings.success ? settings.data : HERMES_DEFAULT_SETTINGS,
      version: Number(r.version),
      report: report.success ? report.data : null,
      reportAt: r.report_at === null ? null : Number(r.report_at),
      viewerRoleId: r.viewer_role_id,
    };
  }

  setBot(botId: string): void {
    this.db.run('UPDATE company_hermes SET bot_id = ? WHERE id = 1', botId);
  }

  setViewerRole(roleId: string | null): void {
    this.db.run('UPDATE company_hermes SET viewer_role_id = ? WHERE id = 1', roleId);
  }

  /** Merges a change of what the Hermes gets (keys, other APIs, models, skills, access) and bumps the version. */
  update(p: HermesStoreChange): void {
    const current = this.load();
    for (const provider of HERMES_PROVIDERS) {
      const value = p.keys?.[provider];
      const envVar = HERMES_PROVIDER_ENV[provider];
      if (value !== undefined) this.setKey(envVar, catalogName(envVar), value);
    }
    for (const [envVar, change] of Object.entries(p.apis ?? {})) this.setKey(envVar, change?.name ?? envVar, change?.value ?? null);
    const settings: HermesSettings = {
      models: p.models ?? current.settings.models,
      disabledSkills: p.disabledSkills ?? current.settings.disabledSkills,
      access: p.access ?? current.settings.access,
    };
    this.db.run('UPDATE company_hermes SET settings = ?, version = version + 1 WHERE id = 1', JSON.stringify(settings));
  }

  /** A change outside these settings (the sites) that the Hermes must get as a new hermes.config. */
  bumpVersion(): void {
    this.db.run('UPDATE company_hermes SET version = version + 1 WHERE id = 1');
  }

  saveReport(report: HermesReport, at: number): void {
    this.db.run('UPDATE company_hermes SET report = ?, report_at = ? WHERE id = 1', JSON.stringify(report), at);
  }

  private setKey(envVar: string, name: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM company_hermes_keys WHERE env_var = ?', envVar);
    else this.db.run('INSERT INTO company_hermes_keys (env_var, name, value) VALUES (?, ?, ?) ON CONFLICT (env_var) DO UPDATE SET name = excluded.name, value = excluded.value', envVar, name, value);
  }
}
