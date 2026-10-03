import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on': string;
  'timeout-minutes'?: number;
  permissions?: unknown;
  strategy: { 'fail-fast': boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const source = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const workflow = parse(source) as Workflow;
const jobs = Object.entries(workflow.jobs);
/** The jobs that run the repository's code on Node; `image` only builds the server image with Docker. */
const nodeJobs = jobs.filter(([name]) => name !== 'image');
const steps = jobs.flatMap(([, job]) => job.steps);
const runIndex = (job: Job, command: string) => job.steps.findIndex((s) => s.run?.split('\n').some((l) => l.trim() === command));

// Reviewed actions only. Updating one = new SHA + version comment, checked by the tests below.
const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'];

describe('ci.yml supply chain', () => {
  it('pins every action to a full commit SHA with its version as a comment', () => {
    const uses = [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('uses only reviewed actions', () => {
    for (const step of steps.filter((s) => s.uses !== undefined)) {
      expect(ALLOWED_ACTIONS, step.uses).toContain(step.uses!.split('@')[0]);
    }
  });

  it('runs with a read-only token that is not left in .git/config', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of jobs) expect(job.permissions, name).toBeUndefined();
    for (const step of steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('never runs untrusted code with repository secrets', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(source).not.toMatch(/pull_request_target|workflow_run|secrets\./);
  });
});

describe('ci.yml jobs', () => {
  it('cancels superseded runs of the same ref', () => {
    expect(workflow.concurrency).toEqual({ group: 'ci-${{ github.ref }}', 'cancel-in-progress': true });
  });

  it('bounds every job in time and lets every OS finish', () => {
    for (const [name, job] of jobs) expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    for (const [name, job] of nodeJobs) expect(job.strategy['fail-fast'], name).toBe(false);
  });

  it('installs Node 24 with the npm cache in every Node job', () => {
    for (const [name, job] of nodeJobs) {
      const setup = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
      expect(setup?.with, name).toEqual({ 'node-version': '24.x', cache: 'npm' });
      expect(job.steps.find((s) => s.name === 'Install dependencies')?.run, name).toMatch(/for attempt in 1 2 3; do\s+npm ci && exit 0/);
    }
  });

  it('builds the server image on every pull request as the release does, without pushing it', () => {
    const image = workflow.jobs.image!;
    expect(image['runs-on']).toBe('ubuntu-latest');
    const run = image.steps.map((st) => st.run ?? '').join('\n');
    expect(run).toMatch(/docker build -f apps\/server\/docker\/Dockerfile/);
    expect(run).toMatch(/cli\.js version/);
    expect(run).toMatch(/cli\.js ghost-dj/);
    expect(run).not.toMatch(/docker (push|login)/);
  });

  it('tests on Windows, Linux and macOS: lint, typecheck, then tests', () => {
    const test = workflow.jobs.test!;
    expect(test.strategy.matrix.os).toEqual(['windows-latest', 'ubuntu-latest', 'macos-latest']);
    const order = ['npm run lint', 'npm run typecheck', 'npm test'].map((c) => runIndex(test, c));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('fetches the verified LiveKit binary before the tests, so the LiveKit integration tests run (spec §14)', () => {
    const test = workflow.jobs.test!;
    const fetch = runIndex(test, 'node scripts/fetch-livekit.mjs');
    expect(fetch).toBeGreaterThan(0);
    expect(fetch).toBeLessThan(runIndex(test, 'npm test'));
  });

  it('gives the Hermes plugin tests a Python with its packages pinned as Hermes pins them (Linux)', () => {
    const test = workflow.jobs.test!;
    const index = test.steps.findIndex((s) => s.name === 'Python for the Hermes plugin tests');
    expect(index).toBeGreaterThan(0);
    const step = test.steps[index]!;
    expect(step.if).toBe("runner.os == 'Linux'");
    expect(step.run).toMatch(/aiohttp==3\.14\.3 cryptography==50\.0\.1 ruamel\.yaml==0\.18\.16/);
    expect(step.run).toMatch(/GHOSTLINK_TEST_PYTHON=.*>> "\$GITHUB_ENV"/);
    expect(index).toBeLessThan(runIndex(test, 'npm test'));
  });

  it('packages on Windows and macOS, then smoke tests the package', () => {
    const pack = workflow.jobs.package!;
    expect(pack.strategy.matrix.os).toEqual(['windows-latest', 'macos-latest']);
    const dist = runIndex(pack, 'npm run dist');
    const smoke = runIndex(pack, 'npm run smoke');
    expect(dist).toBeGreaterThan(0);
    expect(smoke).toBeGreaterThan(dist);
    expect(pack.steps[dist]!.id).toBe('dist');
  });

  it('unlocks a temporary keychain before the macOS smoke test (spec §14)', () => {
    const pack = workflow.jobs.package!;
    const index = pack.steps.findIndex((s) => s.run?.includes('security create-keychain'));
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(runIndex(pack, 'npm run smoke'));
    const step = pack.steps[index]!;
    expect(step.if).toBe("runner.os == 'macOS'");
    for (const command of ['create-keychain', 'set-keychain-settings', 'unlock-keychain', 'list-keychains -d user -s', 'default-keychain -d user -s']) {
      expect(step.run).toContain(`security ${command}`);
    }
    expect(step.run).toContain('::add-mask::');
  });

  it('keeps the installers for 7 days, even when the smoke test fails', () => {
    const upload = workflow.jobs.package!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.if).toBe("${{ !cancelled() && steps.dist.outcome == 'success' }}");
    expect(upload.with).toMatchObject({ 'if-no-files-found': 'error', 'retention-days': 7 });
    expect(String(upload.with?.path).trim().split('\n')).toEqual([
      'apps/desktop/dist/GhostLink-Setup-*.exe',
      'apps/desktop/dist/GhostLink-*-mac-*.dmg',
    ]);
  });
});
