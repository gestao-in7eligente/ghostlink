import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  needs?: string | string[];
  'runs-on': string;
  'timeout-minutes'?: number;
  environment?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const source = read('.github/workflows/docs.yml');
const workflow = parse(source) as Workflow;
const job = (name: string) => workflow.jobs[name]!;
const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
const rootPackage = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

// Every action docs.yml may use, with the exact reviewed commit (spec §16: configure-pages v6,
// upload-pages-artifact v5, deploy-pages v5).
const PINNED = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  'actions/configure-pages': '45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0',
  'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0',
  'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1',
};

describe('docs.yml (spec §16)', () => {
  it('deploys from main only, or on demand', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: null });
    expect(source).not.toMatch(/pull_request|workflow_run|schedule:|tags:/);
  });

  it('pins every action to a reviewed commit SHA with its version as a comment', () => {
    const uses = [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(uses).toHaveLength(5);
    for (const line of uses) {
      const [action, pin] = line.split('@') as [keyof typeof PINNED, string];
      expect(PINNED[action], line).toBe(pin);
    }
  });

  it('grants no permission by default and the minimum per job', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'deploy']);
    expect(job('build').permissions).toEqual({ contents: 'read', pages: 'read' });
    expect(job('deploy').permissions).toEqual({ pages: 'write', 'id-token': 'write' });
  });

  it('never runs two deployments at once and never cancels one midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false });
  });

  it('builds with the repository script, without install scripts or a persisted token', () => {
    const build = job('build');
    expect(build['runs-on']).toBe('ubuntu-latest');
    const checkout = build.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({ 'persist-credentials': false });
    const install = build.steps.find((s) => s.name === 'Install dependencies');
    expect(install?.run).toMatch(/npm ci --ignore-scripts/);
    expect(build.steps.map((s) => s.run ?? '').join('\n')).toMatch(/^npm run docs:build$/m);
    expect(rootPackage.scripts['docs:build']).toBe('vitepress build docs-site');
    expect(rootPackage.devDependencies.vitepress).toBe('1.6.4');
    const upload = build.steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact@'));
    expect(upload?.with).toEqual({ path: 'docs-site/.vitepress/dist' });
    expect(source).not.toMatch(/cache:|actions\/cache@/);
  });

  it('deploys through the github-pages environment after the build', () => {
    const deploy = job('deploy');
    expect(deploy.needs).toBe('build');
    expect(deploy.environment).toEqual({ name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' });
    expect(deploy.steps).toEqual([
      { name: 'Deploy', id: 'deployment', uses: `actions/deploy-pages@${PINNED['actions/deploy-pages']}`.replace(/ #.*/, '') },
    ]);
  });

  it('bounds every job and never hands a secret to the build', () => {
    for (const [name, j] of Object.entries(workflow.jobs)) {
      expect(j['timeout-minutes'], name).toBeGreaterThan(0);
      expect(j['timeout-minutes'], name).toBeLessThanOrEqual(15);
    }
    expect(source).not.toMatch(/secrets\./);
    for (const step of steps) expect(step.run ?? '', step.name).not.toMatch(/\$\{\{/); // untrusted values only through env
  });
});
