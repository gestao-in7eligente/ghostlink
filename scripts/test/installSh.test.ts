// scripts/install.sh (spec §10): shell syntax, the pure helpers, real signature and
// checksum verification (openssl), and --dry-run runs of the whole installation.
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../install.sh', import.meta.url)).replace(/\\/g, '/');

/** Git's bash on Windows (never WSL's System32\bash.exe), the system bash elsewhere. */
function findBash(): string | null {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((c) => existsSync(c)) ?? null;
}
const BASH = findBash();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-install-'));
  dirs.push(d);
  return d;
}
const posix = (p: string) => p.replace(/\\/g, '/');

function bash(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BASH!, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Sources the script (functions only) and runs a snippet. */
function withScript(snippet: string, env: Record<string, string> = {}) {
  return bash(['-c', `set -euo pipefail; source "${SCRIPT}"; ${snippet}`], env);
}

const ROUTE_PUBLIC = '1.1.1.1 via 203.0.113.1 dev eth0 src 203.0.113.10 uid 0\n    cache';
const ROUTE_PRIVATE = '1.1.1.1 via 10.0.0.1 dev ens3 src 10.0.0.5 uid 0\n    cache';

function osRelease(id: string, version: string): string {
  const d = temp();
  const file = join(d, 'os-release');
  writeFileSync(file, `NAME="x"\nID=${id}\nVERSION_ID="${version}"\n`);
  return posix(file);
}

function dryRun(flags: string[], env: Record<string, string> = {}) {
  return bash([SCRIPT, '--dry-run', '--yes', ...flags], {
    GHOSTLINK_TEST_OS_RELEASE: osRelease('ubuntu', '24.04'),
    GHOSTLINK_TEST_ARCH: 'x86_64',
    GHOSTLINK_TEST_ROUTE: ROUTE_PUBLIC,
    GHOSTLINK_TEST_LATEST_JSON: '{"url":"x","tag_name": "v0.1.0","name":"GhostLink v0.1.0 (beta)"}',
    GHOSTLINK_TEST_UFW_STATUS: 'Status: active\n',
    ...env,
  });
}

describe.skipIf(BASH === null)('install.sh', () => {
  it('is valid bash with LF line endings, and shows its usage', () => {
    expect(bash(['-n', SCRIPT]).code).toBe(0);
    const help = bash([SCRIPT, '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/--node-ip <ipv4>/);
    expect(help.out).toMatch(/--dry-run/);
  });

  describe('validators', () => {
    it.each([
      ['is_ipv4 203.0.113.10', 0],
      ['is_ipv4 255.255.255.255', 0],
      ['is_ipv4 256.1.1.1', 1],
      ['is_ipv4 1.2.3', 1],
      ['is_ipv4 01.2.3.4', 1],
      ['is_ipv4 example.com', 1],
      ['is_private_ipv4 10.0.0.5', 0],
      ['is_private_ipv4 172.20.1.1', 0],
      ['is_private_ipv4 192.168.1.1', 0],
      ['is_private_ipv4 100.64.3.3', 0],
      ['is_private_ipv4 127.0.0.1', 0],
      ['is_private_ipv4 172.32.0.1', 1],
      ['is_private_ipv4 203.0.113.10', 1],
      ['is_port 7700', 0],
      ['is_port 0', 1],
      ['is_port 65536', 1],
      ['is_version 0.1.0', 0],
      ['is_version 0.1', 1],
      ["is_name 'Casa do Ze'", 0],
      ["is_name 'a\"b'", 1],
      ["is_name 'a%b'", 1],
      ["is_name '-rf'", 1],
    ])('%s → %i', (call, code) => {
      expect(withScript(call).code).toBe(code);
    });

    it('reads the source IP of the default route and the latest tag', () => {
      expect(withScript(`printf '%s' '${ROUTE_PUBLIC}' | route_source_ip`).out.trim()).toBe('203.0.113.10');
      expect(withScript(`printf '%s' '{"tag_name":"v1.2.3"}' | latest_version_from_json`).out.trim()).toBe('1.2.3');
    });
  });

  describe('verification (real sha256 and openssl Ed25519)', () => {
    const hasOpenssl = BASH !== null && bash(['-c', 'command -v openssl']).code === 0;

    it('verify_checksum accepts the right line (with or without the * marker) and nothing else', () => {
      const d = temp();
      const file = join(d, 'ghostlink-server-0.1.0.tgz');
      writeFileSync(file, 'package bytes');
      const hash = createHash('sha256').update('package bytes').digest('hex');
      const sums = join(d, 'checksums-sha256.txt');
      for (const line of [`${hash}  ghostlink-server-0.1.0.tgz`, `${hash} *ghostlink-server-0.1.0.tgz`]) {
        writeFileSync(sums, `${'0'.repeat(64)}  other.exe\n${line}\n`);
        expect(withScript(`verify_checksum "${posix(file)}" "${posix(sums)}" ghostlink-server-0.1.0.tgz`).code).toBe(0);
      }
      writeFileSync(sums, `${'f'.repeat(64)}  ghostlink-server-0.1.0.tgz\n`);
      expect(withScript(`verify_checksum "${posix(file)}" "${posix(sums)}" ghostlink-server-0.1.0.tgz`).code).not.toBe(0);
      writeFileSync(sums, `${hash}  ghostlink-server-0.1.0.tgz.evil\n`);
      expect(withScript(`verify_checksum "${posix(file)}" "${posix(sums)}" ghostlink-server-0.1.0.tgz`).code).not.toBe(0);
    });

    it.skipIf(!hasOpenssl)('verify_ed25519 checks a detached signature (raw or base64) against the pinned key', () => {
      const d = temp();
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const key = publicKey.export({ format: 'jwk' }).x!;
      const file = join(d, 'pkg.tgz');
      writeFileSync(file, 'the release package');
      const signature = sign(null, Buffer.from('the release package'), privateKey);
      const raw = join(d, 'pkg.tgz.ed25519');
      const text = join(d, 'pkg.tgz.ed25519.txt');
      writeFileSync(raw, signature);
      writeFileSync(text, `${signature.toString('base64')}\n`);
      const verify = (f: string, s: string, k: string) => withScript(`verify_ed25519 "${posix(f)}" "${posix(s)}" "${k}"`).code;
      expect(verify(file, raw, key)).toBe(0);
      expect(verify(file, text, key)).toBe(0);

      const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
      expect(verify(file, raw, other)).not.toBe(0);
      writeFileSync(file, 'the release package, tampered');
      expect(verify(file, raw, key)).not.toBe(0);
      expect(verify(file, raw, 'REPLACE_WITH_RELEASE_PUBLIC_KEY')).not.toBe(0);
      expect(verify(file, raw, 'short')).not.toBe(0);
    });
  });

  describe('--dry-run', () => {
    it('plans the whole installation on a public-IP VPS', () => {
      const r = dryRun([]);
      expect(r.code, r.err).toBe(0);
      const out = r.out;
      expect(out).toContain('Dry run: nothing will be changed.');
      expect(out).toContain('Public IP: 203.0.113.10 (port 7700)');
      expect(out).toContain('deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main');
      expect(out).not.toMatch(/\| *(sudo )?(bash|sh)\b/); // never pipes a remote script into a shell
      expect(out).toContain('+ useradd --system --home-dir /var/lib/ghostlink --no-create-home --shell /usr/sbin/nologin ghostlink');
      expect(out).toContain('GhostLink version: 0.1.0');
      const base = 'https://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.0';
      for (const f of ['ghostlink-server-0.1.0.tgz', 'checksums-sha256.txt', 'ghostlink-server-0.1.0.tgz.ed25519']) expect(out).toContain(`+ download ${base}/${f}`);
      expect(out).toContain('+ verify sha256 of ghostlink-server-0.1.0.tgz');
      expect(out).toContain('+ verify Ed25519 signature');
      expect(out).toContain('+ download https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_linux_amd64.tar.gz');
      expect(out).toContain('+ verify sha256 6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2');
      for (const line of [
        'User=ghostlink',
        'Restart=always',
        'NoNewPrivileges=true',
        'ProtectSystem=strict',
        'ProtectHome=true',
        'PrivateTmp=true',
        'StateDirectory=ghostlink',
        'LimitNOFILE=65536',
      ]) {
        expect(out).toContain(line);
      }
      expect(out).toMatch(/ExecStart=.* \/opt\/ghostlink\/current\/dist\/cli\.js start --data \/var\/lib\/ghostlink --port 7700 --node-ip 203\.0\.113\.10 --public-address 203\.0\.113\.10:7700/);
      expect(out).toContain('NODE_IP=203.0.113.10');
      for (const rule of ['7700/tcp', '7881/tcp', '7882/udp']) expect(out).toContain(`+ ufw allow ${rule}`);
      expect(out).toContain('+ systemctl enable ghostlink.service');
      expect(out).toContain('+ systemctl restart ghostlink.service');
      for (const cmd of ['status', 'setup-code', 'invite']) expect(out).toMatch(new RegExp(`\\+ runuser -u ghostlink -- .*cli\\.js ${cmd} --data /var/lib/ghostlink`));
    });

    it('does not touch ufw when it is inactive', () => {
      const r = dryRun([], { GHOSTLINK_TEST_UFW_STATUS: 'Status: inactive' });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('ufw allow');
    });

    it('refuses a private route IP without --node-ip (1:1 NAT providers), and uses --node-ip when given', () => {
      const r = dryRun([], { GHOSTLINK_TEST_ROUTE: ROUTE_PRIVATE });
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/--node-ip/);
      const ok = dryRun(['--node-ip', '198.51.100.4', '--port', '7710', '--name', 'Casa do Ze'], { GHOSTLINK_TEST_ROUTE: ROUTE_PRIVATE });
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out).toMatch(/--port 7710 --node-ip 198\.51\.100\.4 --public-address 198\.51\.100\.4:7710 --name "Casa do Ze"/);
      expect(ok.out).toContain('+ ufw allow 7710/tcp');
    });

    it('picks the arm64 LiveKit build and its pinned hash', () => {
      const r = dryRun([], { GHOSTLINK_TEST_ARCH: 'aarch64' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('livekit_1.13.7_linux_arm64.tar.gz');
      expect(r.out).toContain('5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9');
    });

    it.each([
      [['--node-ip', '1.2.3.999']],
      [['--node-ip', 'example.com']],
      [['--port', '0']],
      [['--port', '70000']],
      [['--name', 'a"; rm -rf /; "']],
      [['--name', 'line\nbreak']],
      [['--version', '1.2']],
      [['--what']],
    ])('refuses %j', (flags) => {
      expect(dryRun(flags).code).not.toBe(0);
    });

    it.each([
      ['fedora', '40', false],
      ['ubuntu', '20.04', false],
      ['ubuntu', '22.04', true],
      ['debian', '11', false],
      ['debian', '12', true],
    ])('%s %s supported: %s', (id, version, ok) => {
      expect(dryRun([], { GHOSTLINK_TEST_OS_RELEASE: osRelease(id, version) }).code === 0).toBe(ok);
    });

    it('refuses an unsupported CPU', () => {
      expect(dryRun([], { GHOSTLINK_TEST_ARCH: 'riscv64' }).code).not.toBe(0);
    });
  });
});
