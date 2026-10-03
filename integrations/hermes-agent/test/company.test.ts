// ghostlink/company.py on its own (company_check.py): skipped where Python with ruamel.yaml and aiohttp
// is missing (GHOSTLINK_TEST_PYTHON picks the interpreter; CI's Linux job has one).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  API_ENV_ALLOWED_SUFFIXES,
  API_ENV_DENIED_NAMES,
  API_ENV_DENIED_PREFIXES,
  API_ENV_DENIED_SUFFIXES,
  API_ENV_VAR,
  FEATURE_ENTERPRISE_APIS,
  HERMES_API_CATALOG,
  HERMES_PROVIDER_ENV,
  HERMES_PROVIDERS_V1,
  apiEnvVarProblem,
} from '@ghostlink/shared';

const SCRIPT = fileURLToPath(new URL('./company_check.py', import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL('../ghostlink/', import.meta.url));

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

// Every list entry, each suffix and the edges of the shape rule (a trailing newline among them: Python's `$`
// would take it).
const SAMPLES = [
  ...API_ENV_DENIED_NAMES,
  ...API_ENV_DENIED_PREFIXES.map((p) => `${p}X_KEY`),
  ...API_ENV_DENIED_SUFFIXES.map((s) => `MINHA${s}`),
  ...API_ENV_ALLOWED_SUFFIXES.map((s) => `MINHA${s}`),
  ...HERMES_API_CATALOG.map((a) => a.envVar),
  'MINHA_API_KEY\n',
  '\nMINHA_API_KEY',
  'MINHA_API',
  'minha_key',
  '1ABC_KEY',
  'AB',
  `A${'B'.repeat(59)}_KEY`,
  `A${'B'.repeat(60)}_KEY`,
  'MACROL_MCP_KEY',
  'X_PROXY_KEY',
  'É_KEY',
];

describe.skipIf(PYTHON === null)('the company Hermes plugin code (spec §3)', () => {
  it('applies models, skills, keys and access, keeps backups, refuses an unknown shape and deletes memory', () => {
    const r = spawnSync(PYTHON!, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });

  it('refuses the same variable names as packages/shared (the four lists, the catalog and apiEnvVarProblem)', () => {
    const code = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(PLUGIN_DIR)})`,
      'import company as c',
      'samples = json.loads(sys.stdin.read())',
      'print(json.dumps({"names": sorted(c.ENV_DENIED_NAMES), "prefixes": list(c.ENV_DENIED_PREFIXES),',
      '  "deniedSuffixes": list(c.ENV_DENIED_SUFFIXES), "allowedSuffixes": list(c.ENV_ALLOWED_SUFFIXES),',
      '  "pattern": c._API_ENV.pattern, "catalog": list(c.API_CATALOG_ENV), "providers": c.PROVIDER_ENV,',
      '  "v1": list(c.PROVIDERS_V1), "feature": c.FEATURE_APIS, "problems": [c.api_env_problem(s) for s in samples]}))',
    ].join('\n');
    const r = spawnSync(PYTHON!, ['-c', code], { encoding: 'utf8', input: JSON.stringify(SAMPLES), env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    const py = JSON.parse(r.stdout);
    expect(py.names).toEqual([...API_ENV_DENIED_NAMES].sort());
    expect(py.prefixes).toEqual([...API_ENV_DENIED_PREFIXES]);
    expect(py.deniedSuffixes).toEqual([...API_ENV_DENIED_SUFFIXES]);
    expect(py.allowedSuffixes).toEqual([...API_ENV_ALLOWED_SUFFIXES]);
    expect(`^${py.pattern}$`).toBe(API_ENV_VAR.source);
    expect(py.catalog).toEqual(HERMES_API_CATALOG.map((a) => a.envVar));
    expect(py.providers).toEqual(HERMES_PROVIDER_ENV);
    expect(py.v1).toEqual([...HERMES_PROVIDERS_V1]);
    expect(py.feature).toBe(FEATURE_ENTERPRISE_APIS);
    expect(py.problems).toEqual(SAMPLES.map((s) => apiEnvVarProblem(s)));
  });
});
