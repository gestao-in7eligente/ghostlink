import { describe, expect, it } from 'vitest';
import { HERMES_DEFAULT_SETTINGS, type HermesReport, type HermesState } from '@ghostlink/shared';
import { providersWithKeys } from '../../src/renderer/features/bots/hermes/hermesModel.js';
import { apiPatch, apiRows, newApiPatch, otherApiProblem, savedKeys } from '../../src/renderer/features/bots/hermes/apiModel.js';

const NO_KEYS = { deepseek: null, openrouter: null, 'openai-api': null, anthropic: null, gemini: null };
const report = (keys: Partial<HermesReport['status']['keys']>): HermesReport => ({
  appliedVersion: 1,
  skills: [],
  memory: { company: [], people: [] },
  status: { model: null, fallback: null, keys: { deepseek: 'missing', openrouter: 'missing', 'openai-api': 'missing', anthropic: 'missing', gemini: 'missing', ...keys }, unsupported: null, envOverride: [] },
});
const state = (o: Partial<HermesState> = {}): HermesState => ({
  botId: 'b'.repeat(32), connected: true, locked: false, keys: NO_KEYS, apis: [], settings: HERMES_DEFAULT_SETTINGS,
  version: 1, report: null, reportAt: null, viewerRoleId: null, ...o,
});

describe('the API tab (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('lists the AIs, the other APIs, then the owner’s own by name, each with its last 4 and the AIs’ key test', () => {
    const s = state({
      keys: { ...NO_KEYS, deepseek: { last4: 'ab12' }, gemini: { last4: 'cd34' } },
      apis: [
        { envVar: 'ZETA_KEY', name: 'Zeta', last4: 'zz99' },
        { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', last4: 'ee11' },
        { envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' },
      ],
      report: report({ deepseek: 'ok', gemini: 'refused' }),
    });
    const rows = apiRows(s, true);
    expect(rows.map((r) => [r.group, r.envVar])).toEqual([
      ['ai', 'DEEPSEEK_API_KEY'], ['ai', 'OPENROUTER_API_KEY'], ['ai', 'OPENAI_API_KEY'], ['ai', 'ANTHROPIC_API_KEY'], ['ai', 'GEMINI_API_KEY'],
      ['other', 'ELEVENLABS_API_KEY'], ['other', 'GROK_API_KEY'], ['other', 'YUNWU_API_KEY'],
      ['custom', 'ALFA_KEY'], ['custom', 'ZETA_KEY'],
    ]);
    expect(rows[0]).toMatchObject({ name: 'DeepSeek', last4: 'ab12', test: 'ok' });
    expect(rows[1]).toMatchObject({ last4: null, test: null });
    expect(rows[4]).toMatchObject({ name: 'Google Gemini', last4: 'cd34', test: 'refused' });
    expect(rows[5]).toMatchObject({ last4: 'ee11', test: null });
    expect(savedKeys(s)).toBe(5);
  });

  it('a server without enterpriseApis: DeepSeek and OpenRouter only', () => {
    expect(apiRows(state({ apis: [{ envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' }] }), false).map((r) => r.envVar)).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
  });

  it('checks "Outra API" before sending', () => {
    const s = state({ apis: [{ envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' }] });
    const ok = { name: 'Minha API', envVar: 'MINHA_API_KEY', key: 'fake-key-0001' };
    expect(otherApiProblem(s, ok)).toBeNull();
    expect(otherApiProblem(s, { ...ok, name: '  ' })).toBe('name');
    expect(otherApiProblem(s, { ...ok, envVar: 'minha' })).toBe('format');
    expect(otherApiProblem(s, { ...ok, envVar: 'HERMES_KEY' })).toBe('reserved');
    expect(otherApiProblem(s, { ...ok, envVar: 'MINHA_API' })).toBe('suffix');
    for (const end of ['_KEY', '_TOKEN', '_SECRET', '_PASSWORD']) expect(otherApiProblem(s, { ...ok, envVar: `MINHA${end}` })).toBeNull();
    expect(otherApiProblem(s, { ...ok, envVar: 'GROK_API_KEY' })).toBe('catalog');
    expect(otherApiProblem(s, { ...ok, envVar: 'ALFA_KEY' })).toBe('taken');
    expect(otherApiProblem(s, { ...ok, key: 'curta' })).toBe('key');
    const full = state({ apis: Array.from({ length: 30 }, (_, i) => ({ envVar: `API_${i}_KEY`, name: `API ${i}`, last4: '0000' })) });
    expect(otherApiProblem(full, ok)).toBe('limit');
  });

  it('Modelos lists every catalog AI that has a key', () => {
    const s = state({ keys: { ...NO_KEYS, anthropic: { last4: 'aa11' }, 'openai-api': { last4: 'bb22' }, gemini: { last4: 'cc33' } } });
    expect(providersWithKeys(s)).toEqual(['openai-api', 'anthropic', 'gemini']);
  });

  it('saves an AI through keys and the others through apis', () => {
    expect(apiPatch({ envVar: 'GEMINI_API_KEY', provider: 'gemini' }, ' fake-key-0001 ')).toEqual({ keys: { gemini: 'fake-key-0001' } });
    expect(apiPatch({ envVar: 'GEMINI_API_KEY', provider: 'gemini' }, null)).toEqual({ keys: { gemini: null } });
    expect(apiPatch({ envVar: 'YUNWU_API_KEY', provider: null }, 'fake-key-0001')).toEqual({ apis: { YUNWU_API_KEY: { value: 'fake-key-0001' } } });
    expect(apiPatch({ envVar: 'ALFA_KEY', provider: null }, null)).toEqual({ apis: { ALFA_KEY: null } });
    expect(newApiPatch({ name: ' Minha API ', envVar: 'MINHA_API_KEY', key: 'fake-key-0001' })).toEqual({ apis: { MINHA_API_KEY: { name: 'Minha API', value: 'fake-key-0001' } } });
  });
});
