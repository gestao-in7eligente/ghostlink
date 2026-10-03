// ghostlink/sites.py on its own (sites_check.py): skipped where Python with ruamel.yaml and aiohttp is
// missing (GHOSTLINK_TEST_PYTHON picks the interpreter; CI's Linux job has one).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./sites_check.py', import.meta.url));

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

describe.skipIf(PYTHON === null)('the company sites on the Hermes side (spec 2026-10-03 §2)', () => {
  it('writes the skill without a secret, keeps the summary job and answers the two tools', () => {
    const r = spawnSync(PYTHON!, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });
});
