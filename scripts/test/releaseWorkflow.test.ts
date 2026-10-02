import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELEASE_PUBLIC_KEY } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { publicKeyPem } from '../lib/releaseKey.mjs';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  name: string;
  needs?: string | string[];
  'runs-on': string;
  'timeout-minutes'?: number;
  environment?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const source = read('.github/workflows/release.yml');
const workflow = parse(source) as Workflow;
const jobs = Object.entries(workflow.jobs);
const job = (name: string) => workflow.jobs[name]!;
const steps = jobs.flatMap(([, j]) => j.steps);
const runOf = (j: Job) => j.steps.map((s) => s.run ?? '').join('\n');

// Every action release.yml may use, with the exact reviewed commit.
const PINNED = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
  'sigstore/cosign-installer': '6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2',
};

describe('release.yml trigger and supply chain (spec §15)', () => {
  it('runs only for pushed v* tags', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
    expect(source).not.toMatch(/pull_request|workflow_run|workflow_dispatch|schedule:/);
  });

  it('pins every action to a reviewed commit SHA with its version as a comment', () => {
    const uses = [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const [action, pin] = line.split('@') as [keyof typeof PINNED, string];
      expect(PINNED[action], line).toBe(pin);
    }
  });

  it('grants no permission by default and the minimum per job', () => {
    expect(workflow.permissions).toEqual({});
    expect(job('version').permissions).toEqual({ contents: 'read' });
    expect(job('windows').permissions).toEqual({ contents: 'read' });
    expect(job('server').permissions).toEqual({ contents: 'read' });
    expect(job('compat').permissions).toEqual({ contents: 'read' });
    expect(job('sign').permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(job('publish').permissions).toEqual({ contents: 'write' });
    expect(job('image').permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write' });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['compat', 'image', 'publish', 'server', 'sign', 'version', 'windows']);
  });

  it('never leaves a token in .git/config and never caches dependencies', () => {
    for (const step of steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      expect(step.with).toEqual({ 'persist-credentials': false });
    }
    for (const step of steps.filter((s) => s.uses?.startsWith('actions/setup-node@'))) {
      expect(step.with).toEqual({ 'node-version': '24.x' });
    }
    expect(source).not.toMatch(/actions\/cache|cache:/);
  });

  it('passes untrusted values to scripts only through env', () => {
    for (const step of steps.filter((s) => s.run)) expect(step.run, step.name).not.toMatch(/\$\{\{/);
    expect(job('version').steps.find((s) => s.id === 'version')?.env).toEqual({ TAG: '${{ github.ref_name }}' });
  });

  it('bounds every job in time and never cancels a release half-way', () => {
    for (const [name, j] of jobs) expect(j['timeout-minutes'], name).toBeGreaterThan(0);
    expect(workflow.concurrency).toEqual({ group: 'release-${{ github.ref }}', 'cancel-in-progress': false });
  });
});

describe('release.yml secrets', () => {
  it('gives the release key only to the approved sign job, in one step, as an env variable', () => {
    const uses = [...source.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(uses).toEqual(['RELEASE_ED25519_PRIVATE_KEY_PEM']);
    const holders = jobs.flatMap(([name, j]) => j.steps.filter((s) => JSON.stringify(s).includes('secrets.')).map((s) => ({ name, s })));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.name).toBe('sign');
    expect(holders[0]!.s.env).toEqual({ RELEASE_ED25519_PRIVATE_KEY_PEM: '${{ secrets.RELEASE_ED25519_PRIVATE_KEY_PEM }}' });
  });

  it('runs only the sign job in the protected release environment', () => {
    expect(job('sign').environment).toBe('release');
    for (const [name, j] of jobs.filter(([n]) => n !== 'sign')) expect(j.environment, name).toBeUndefined();
  });

  it('installs no npm package in the job that holds the key', () => {
    expect(runOf(job('sign'))).not.toMatch(/\bnpm\b|\bnpx\b/);
  });
});

describe('release.yml builds', () => {
  it('checks the tag against the package versions first, and everything depends on it', () => {
    expect(runOf(job('version'))).toContain('node scripts/release-version.mjs "$TAG" >> "$GITHUB_OUTPUT"');
    expect(job('version').outputs).toEqual({ version: '${{ steps.version.outputs.version }}' });
    for (const name of ['windows', 'server', 'compat']) expect(job(name).needs).toBe('version');
    expect(job('sign').needs).toEqual(['version', 'windows', 'server', 'compat']);
    expect(job('image').needs).toEqual(['version', 'sign']);
    expect(job('publish').needs).toEqual(['version', 'sign', 'image']);
  });

  it('builds the NSIS installer on Windows with LiveKit when available, smoke tests it and keeps the update files', () => {
    const windows = job('windows');
    expect(windows['runs-on']).toBe('windows-latest');
    const run = runOf(windows);
    expect(run).toMatch(/for attempt in 1 2 3; do\s+npm ci && exit 0/);
    expect(run).toMatch(/if \[ -f scripts\/fetch-livekit\.mjs \]; then\s+node scripts\/fetch-livekit\.mjs\s+else\s+echo "::warning::/);
    const order = ['node scripts/fetch-livekit.mjs', 'npm run dist', 'npm run smoke', 'cp "apps/desktop/dist/'].map((c) => run.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(run).toContain('"GhostLink-Setup-${VERSION}.exe" "GhostLink-Setup-${VERSION}.exe.blockmap" latest.yml');
    const upload = windows.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.with).toMatchObject({ name: 'release-windows', path: 'release/', 'if-no-files-found': 'error' });
  });

  it('packages the server CLI reproducibly on Linux and runs the packaged CLI', () => {
    const server = job('server');
    expect(server['runs-on']).toBe('ubuntu-latest');
    const run = runOf(server);
    expect(run).toContain('npm run build -w @ghostlink/server');
    expect(run).toContain('SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" node scripts/pack-server.mjs release');
    expect(run).toContain('test -f "release/ghostlink-server-${VERSION}.tgz"');
    expect(run).toMatch(/tar -xzf "release\/ghostlink-server-\$\{VERSION\}\.tgz"/);
    expect(run).toContain('dist/cli.js" version)" = "${VERSION}"');
    const upload = server.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.with).toMatchObject({ name: 'release-server', path: 'release/', 'if-no-files-found': 'error' });
  });

  it("packs the bots' discord.js compatibility package and installs it as a bot would (bots spec §4)", () => {
    const compat = job('compat');
    expect(compat['runs-on']).toBe('ubuntu-latest');
    const run = runOf(compat);
    expect(run).toMatch(/for attempt in 1 2 3; do\s+npm ci && exit 0/);
    // prepack builds dist/; the file name carries the version, so a package.json behind the tag fails here.
    expect(run).toContain('npm pack -w @ghostlink/discord-compat --pack-destination release');
    expect(run).toContain('test -f "release/ghostlink-discord-compat-${VERSION}.tgz"');
    expect(run).toContain('npm install "$GITHUB_WORKSPACE/release/ghostlink-discord-compat-${VERSION}.tgz"');
    // Both entry points, CommonJS and ESM, load from the installed tarball with this version.
    expect(run).toContain(`test "$(node -p "require('@ghostlink/discord-compat').version")" = "\${VERSION}"`);
    expect(run).toMatch(/node --input-type=module -e "import \{ version, Client \} from '@ghostlink\/discord-compat';/);
    const order = ['npm pack', 'test -f', 'npm install'].map((c) => run.indexOf(c));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A release-* artifact: the sign job signs it, lists it in checksums-sha256.txt, and publish attaches it.
    const upload = compat.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.with).toMatchObject({ name: 'release-compat', path: 'release/', 'if-no-files-found': 'error' });
    expect(compat.environment).toBeUndefined();
  });
});

describe('release.yml signing and publishing', () => {
  it('signs every file with Ed25519, then checksums them and signs the checksums', () => {
    const run = runOf(job('sign'));
    expect(run).toContain('node scripts/sign-release.mjs release/checksums-sha256.txt'); // → checksums-sha256.txt.ed25519
    const order = ['node scripts/sign-release.mjs release/*', 'node scripts/checksums.mjs release', 'node scripts/sign-release.mjs release/checksums-sha256.txt'].map((c) => run.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const download = job('sign').steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({ pattern: 'release-*', 'merge-multiple': true, path: 'release' });
  });

  it('refuses to go on unless the signed checksums name the installer and server package of this version', () => {
    const sign = job('sign');
    const signing = sign.steps.findIndex((s) => s.run?.includes('node scripts/sign-release.mjs release/checksums-sha256.txt'));
    const check = sign.steps.findIndex((s) => s.run === 'node scripts/verify-release.mjs release "$VERSION"');
    const cosign = sign.steps.findIndex((s) => s.uses?.startsWith('sigstore/cosign-installer@'));
    expect(signing).toBeGreaterThanOrEqual(0);
    expect(check).toBe(signing + 1);
    expect(cosign).toBeGreaterThan(check);
    expect(sign.steps[check]!.env).toBeUndefined(); // needs no secret
  });

  it('signs the checksums keyless with cosign (Sigstore) and verifies them as users will', () => {
    const sign = job('sign');
    const install = sign.steps.findIndex((s) => s.uses?.startsWith('sigstore/cosign-installer@'));
    const cosign = sign.steps.findIndex((s) => s.run === 'cosign sign-blob --yes --bundle checksums-sha256.txt.sigstore.json checksums-sha256.txt');
    expect(install).toBeGreaterThan(0);
    expect(cosign).toBeGreaterThan(install);
    expect(sign.steps[cosign]!['working-directory']).toBe('release');
    const verify = sign.steps[cosign + 1]!;
    expect(verify.env?.IDENTITY).toBe('https://github.com/${{ github.repository }}/.github/workflows/release.yml@${{ github.ref }}');
    expect(verify.run).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
    expect(verify.run).toContain('sha256sum -c checksums-sha256.txt');
  });

  it('publishes a normal release marked latest, never a draft or pre-release, and never creates the tag', () => {
    const publish = job('publish');
    const create = publish.steps.find((s) => s.run?.includes('gh release create'))!;
    expect(create.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    const args = create.run!.replace(/\\\n\s*/g, ' ');
    expect(args).toContain('gh release create "v${VERSION}" release/*');
    for (const flag of ['--verify-tag', '--latest', '--title "GhostLink v${VERSION} (beta)"', '--notes-file "release-notes/${VERSION}.md"']) {
      expect(args).toContain(flag);
    }
    expect(args).not.toMatch(/--prerelease|--draft|--target/);
    const download = publish.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({ name: 'signed-release', path: 'release' });
  });
});

describe('release.yml server image (Railway provisioning, v0.2)', () => {
  const image = job('image');

  it('builds the image from the server Dockerfile only after the approval, with the Docker CLI', () => {
    expect(image.env).toEqual({ VERSION: '${{ needs.version.outputs.version }}', IMAGE: 'ghcr.io/${{ github.repository_owner }}/ghostlink-server' });
    expect(image.environment).toBeUndefined();
    const run = runOf(image);
    expect(run).toContain('docker build -f apps/server/docker/Dockerfile');
    expect(run).toContain('-t "${IMAGE}:${VERSION}" .');
    expect(image.steps.filter((s) => s.uses).map((s) => s.uses!.split('@')[0])).toEqual(['actions/checkout', 'sigstore/cosign-installer']);
  });

  it('checks the version inside the image before pushing it, then signs the pushed digest', () => {
    const at = (text: string) => image.steps.findIndex((s) => s.run?.includes(text));
    const smoke = at('/opt/ghostlink/dist/cli.js version)" = "${VERSION}"');
    const push = at('docker push "${IMAGE}:${VERSION}"');
    const sign = at('cosign sign --yes "$DIGEST"');
    expect(smoke).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(smoke);
    expect(sign).toBeGreaterThan(push);
  });

  it('also pushes the same image as :latest after the version tag, covered by the one signature of its digest', () => {
    // Docker hosts that follow releases by themselves (Watchtower) pull :latest (servers follow the app, §1).
    const push = image.steps.find((s) => s.run?.includes('docker push "${IMAGE}:${VERSION}"'))!;
    const lines = push.run!.split('\n').map((l) => l.trim());
    const at = (text: string) => lines.indexOf(text);
    expect(at('docker tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"')).toBeGreaterThan(at('docker push "${IMAGE}:${VERSION}"'));
    expect(at('docker push "${IMAGE}:latest"')).toBeGreaterThan(at('docker tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"'));
    expect(at('docker logout ghcr.io')).toBeGreaterThan(at('docker push "${IMAGE}:latest"'));
    // The signed digest is the version tag's, the one :latest points to: no unsigned image under either tag.
    expect(push.run).toContain(`echo "DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "\${IMAGE}:\${VERSION}")" >> "$GITHUB_ENV"`);
    const sign = image.steps.findIndex((s) => s.run?.includes('cosign sign --yes "$DIGEST"'));
    expect(sign).toBeGreaterThan(image.steps.indexOf(push));
    // Only these two tags, both of this image.
    expect(runOf(image).match(/"\$\{IMAGE\}:[^"]*"/g)!.every((t) => ['"${IMAGE}:${VERSION}"', '"${IMAGE}:latest"'].includes(t))).toBe(true);
  });

  it('logs in to GHCR with the job token through stdin only', () => {
    for (const step of image.steps.filter((s) => s.run?.includes('login ghcr.io'))) {
      expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}', ACTOR: '${{ github.actor }}' });
      expect(step.run).toMatch(/printf '%s' "\$GH_TOKEN" \| (docker|cosign) login ghcr\.io -u "\$ACTOR" --password-stdin/);
    }
  });
});

describe('release-notes/0.1.0.md', () => {
  const notes = read('release-notes/0.1.0.md');

  it('is bilingual and carries the SmartScreen instructions', () => {
    expect(notes).toContain('## Português');
    expect(notes).toContain('## English');
    expect(notes).toContain('Mais informações → Executar assim mesmo');
    expect(notes).toContain('More info → Run anyway');
  });

  it('explains verification with the real cosign identity and release key', () => {
    expect(notes).toContain('--certificate-identity "https://github.com/gestao-in7eligente/ghostlink/.github/workflows/release.yml@refs/tags/v0.1.0"');
    expect(notes).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
    const pem = publicKeyPem(RELEASE_PUBLIC_KEY).trim().split('\n');
    for (const line of pem) expect(notes).toContain(`   ${line}`);
    expect(notes).toContain('openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin');
  });

  it('does not promise features that are out of v0.1', () => {
    expect(notes).toMatch(/Ainda não tem:\*\* câmera, compartilhamento de tela, arquivos e imagens, avatares e a versão para macOS/);
    expect(notes).toMatch(/Not yet:\*\* camera, screen sharing, files and images, avatars and the macOS app/);
  });
});

describe('release-notes/0.2.0.md', () => {
  const notes = read('release-notes/0.2.0.md');

  it('is bilingual and carries the SmartScreen instructions', () => {
    expect(notes).toContain('## Português');
    expect(notes).toContain('## English');
    expect(notes).toContain('Mais informações → Executar assim mesmo');
    expect(notes).toContain('More info → Run anyway');
  });

  it('explains verification with the real cosign identity and release key, for the files and the image', () => {
    const identity = '--certificate-identity "https://github.com/gestao-in7eligente/ghostlink/.github/workflows/release.yml@refs/tags/v0.2.0"';
    // Twice per language: the checksums and the server image.
    expect(notes.split(identity)).toHaveLength(5);
    expect(notes).toContain('cosign verify ghcr.io/gestao-in7eligente/ghostlink-server:0.2.0');
    const pem = publicKeyPem(RELEASE_PUBLIC_KEY).trim().split('\n');
    for (const line of pem) expect(notes).toContain(`   ${line}`);
    expect(notes).not.toContain('0.1.0.exe');
  });

  it('says what Railway hosting costs and that voice goes over TCP there, and promises nothing unbuilt', () => {
    expect(notes).toMatch(/O custo vai para a sua conta Railway/);
    expect(notes).toMatch(/The cost goes to your Railway account/);
    expect(notes).toMatch(/No Railway a voz passa por TCP/);
    expect(notes).toMatch(/On Railway, voice goes over TCP/);
    expect(notes).toMatch(/Ainda não tem:\*\* amigos e mensagens diretas/);
    expect(notes).toMatch(/Not yet:\*\* friends and direct messages/);
  });
});
