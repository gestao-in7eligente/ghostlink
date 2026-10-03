import { describe, expect, it } from 'vitest';
import { HERMES_DEFAULT_SETTINGS, type HermesReport, type HermesState } from '@ghostlink/shared';
import { canCreateCompanyHermes, initialModels, modelsSaveable, providersWithKeys, skillEnabled, statusLines, toggledSkills } from '../../src/renderer/features/bots/hermes/hermesModel.js';

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

  it('starts the models from providers that have a key, and saves only those', () => {
    const only = state();
    expect(initialModels(only)).toEqual({ primary: HERMES_DEFAULT_SETTINGS.models.primary, fallback: null });
    const noPrimary = state({ keys: { deepseek: null, openrouter: { last4: 'cd34' } } });
    expect(initialModels(noPrimary).primary).toEqual({ provider: 'openrouter', model: '' });
    expect(initialModels(noPrimary).fallback).toEqual(HERMES_DEFAULT_SETTINGS.models.fallback);
    const ok = { provider: 'deepseek' as const, model: 'm' };
    expect(modelsSaveable(['deepseek'], ok, null)).toBe(true);
    expect(modelsSaveable(['deepseek'], { ...ok, model: ' ' }, null)).toBe(false);
    expect(modelsSaveable(['deepseek'], { provider: 'openrouter', model: 'm' }, null)).toBe(false);
    expect(modelsSaveable(['deepseek'], ok, { provider: 'openrouter', model: 'm' })).toBe(false);
    expect(modelsSaveable(['deepseek', 'openrouter'], ok, { provider: 'openrouter', model: 'm' })).toBe(true);
  });
});
