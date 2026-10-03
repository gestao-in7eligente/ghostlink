import { describe, expect, it } from 'vitest';
import { HERMES_API_CATALOG, HERMES_LIMITS, HERMES_PROVIDERS, HERMES_PROVIDER_ENV, apiEnvVarProblem, hermesReportSchema, hermesUpdateSchema } from '../src/index.js';

// Made for the test, obviously not a key.
const FAKE = 'fake-key-0001';

describe('the API tab: catalog and variable names (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('lists the five AIs by the variable Hermes reads, then the other APIs', () => {
    expect(HERMES_API_CATALOG.map((a) => a.envVar)).toEqual([
      'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY', 'GROK_API_KEY', 'YUNWU_API_KEY',
    ]);
    expect(HERMES_API_CATALOG.filter((a) => a.provider !== null).map((a) => a.provider)).toEqual([...HERMES_PROVIDERS]);
    for (const p of HERMES_PROVIDERS) expect(HERMES_API_CATALOG.find((a) => a.provider === p)?.envVar).toBe(HERMES_PROVIDER_ENV[p]);
  });

  it.each(['MINHA_API_KEY', 'SERPAPI_KEY', 'ABC', 'WP_PASS_2', 'X'.repeat(64)])('takes %s for "Outra API"', (name) => {
    expect(apiEnvVarProblem(name)).toBeNull();
  });

  it.each(['', 'AB', 'my_key', '1KEY', '_KEY', 'MY-KEY', 'MY KEY', 'X'.repeat(65)])('refuses the shape of %j', (name) => {
    expect(apiEnvVarProblem(name)).toBe('format');
  });

  it.each(['PATH', 'HOME', 'SHELL', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'TERMINAL_ENV', 'GATEWAY_ALLOWED_USERS', 'HERMES_HOME', 'GHOSTLINK_BOT', 'GHOSTLINK_COMPANY'])(
    'refuses the system, Hermes or GhostLink variable %s',
    (name) => expect(apiEnvVarProblem(name)).toBe('reserved'),
  );

  it('a catalog variable is not "Outra API"', () => {
    expect(apiEnvVarProblem('ELEVENLABS_API_KEY')).toBe('catalog');
    expect(apiEnvVarProblem('DEEPSEEK_API_KEY')).toBe('catalog');
  });

  it('hermes.update takes keys for the five AIs and 1 to 30 API changes', () => {
    expect(hermesUpdateSchema.safeParse({ keys: { gemini: FAKE, deepseek: null } }).success).toBe(true);
    expect(hermesUpdateSchema.safeParse({ apis: { MINHA_API_KEY: { name: 'Minha API', value: FAKE }, YUNWU_API_KEY: null } }).success).toBe(true);
    expect(hermesUpdateSchema.safeParse({ apis: { my_key: null } }).success).toBe(false);
    expect(hermesUpdateSchema.safeParse({ apis: {} }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: HERMES_LIMITS.maxApis + 1 }, (_, i) => [`API_${i}_KEY`, null]));
    expect(hermesUpdateSchema.safeParse({ apis: many }).success).toBe(false);
  });

  it("a plugin 1.1's report (two key results) still parses; the other AIs read as unchecked", () => {
    const status = { model: null, fallback: null, keys: { deepseek: 'ok', openrouter: 'missing' }, unsupported: null, envOverride: [] };
    const parsed = hermesReportSchema.parse({ appliedVersion: 1, skills: [], memory: { company: [], people: [] }, status });
    expect(parsed.status.keys).toEqual({ deepseek: 'ok', openrouter: 'missing', 'openai-api': 'unchecked', anthropic: 'unchecked', gemini: 'unchecked' });
  });
});
