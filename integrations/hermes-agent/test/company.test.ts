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
