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
  viewer_role_id: string | null;
}

export interface HermesRecord {
  botId: string | null;
  /** Secrets: only for hermes.config, never for an answer or a log. */
  keys: Record<HermesProvider, string | null>;
  settings: HermesSettings;
  version: number;
  report: HermesReport | null;
  reportAt: number | null;
  /** The role that sees the company Hermes's page (010_hermes_viewer_role.sql); never in hermes.config. */
  viewerRoleId: string | null;
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
    const r = this.db.get<Row>('SELECT bot_id, deepseek_key, openrouter_key, settings, version, report, report_at, viewer_role_id FROM company_hermes WHERE id = 1')!;
    const settings = hermesSettingsSchema.safeParse(json(r.settings));
    const report = hermesReportSchema.safeParse(json(r.report));
    return {
      botId: r.bot_id,
      keys: { deepseek: r.deepseek_key, openrouter: r.openrouter_key },
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

  /** Merges a change of what the Hermes gets (keys, models, skills, access) and bumps the version. */
  update(p: Omit<HermesUpdatePayload, 'viewerRoleId'>): void {
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
