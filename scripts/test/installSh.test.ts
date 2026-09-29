// scripts/install.sh (spec §10): shell syntax, the pure helpers, real signature and
// checksum verification (openssl), and --dry-run runs of the whole installation, some
// of them against local release files so the checks of the server package really run.
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyPairKeyObjectResult } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function bash(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const r = spawnSync(BASH!, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000, cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const HAS_OPENSSL = BASH !== null && bash(['-c', 'command -v openssl']).code === 0;

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
    // Nothing installed yet (never the real /opt/ghostlink/current of the machine running the tests).
    GHOSTLINK_TEST_CURRENT: posix(join(temp(), 'current')),
    ...env,
  });
}

/** An /opt/ghostlink/current link to releases/<version>, as install.sh leaves it. */
function installed(version: string): string {
  const d = temp();
  const target = join(d, 'releases', version);
  mkdirSync(target, { recursive: true });
  const link = join(d, 'current');
  symlinkSync(target, link, 'junction'); // a junction needs no privilege on Windows; a symlink elsewhere
  return posix(link);
}

const SUMS = 'checksums-sha256.txt';

interface ReleaseOptions {
  /** The release signing key (default: a fresh one). */
  keys?: KeyPairKeyObjectResult;
  /** The "version" of the package.json inside the .tgz (default: the release version). */
  packageVersion?: string;
  /** Rewrites the .tgz line of checksums-sha256.txt before the file is signed. */
  sumsLine?: (line: string) => string;
  /** Signs checksums-sha256.txt with another key. */
  forgeSums?: boolean;
}

/**
 * The files of release <version> in a local directory, as release.yml publishes them: the
 * server .tgz and its raw Ed25519 signature, checksums-sha256.txt and its base64 signature.
 */
function release(version: string, options: ReleaseOptions = {}) {
  const d = temp();
  const keys = options.keys ?? generateKeyPairSync('ed25519');
  const pkg = join(d, 'pkg', 'package');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: '@ghostlink/server', version: options.packageVersion ?? version }, null, 2)}\n`);
  writeFileSync(join(pkg, 'dist', 'cli.js'), 'console.log("GhostLink");\n');
  const dir = join(d, 'release');
  mkdirSync(dir);
  const tgz = `ghostlink-server-${version}.tgz`;
  const tar = bash(['-c', `tar -czf "${tgz}" -C ../pkg package`], {}, dir); // relative paths: "C:/…" is a remote host to tar
  expect(tar.code, tar.err).toBe(0);
  const bytes = readFileSync(join(dir, tgz));
  writeFileSync(join(dir, `${tgz}.ed25519`), sign(null, bytes, keys.privateKey));
  const line = `${createHash('sha256').update(bytes).digest('hex')}  ${tgz}`;
  const sums = `${'0'.repeat(64)}  GhostLink-Setup-${version}.exe\n${(options.sumsLine ?? ((l) => l))(line)}\n`;
  writeFileSync(join(dir, SUMS), sums);
  const signer = options.forgeSums ? generateKeyPairSync('ed25519').privateKey : keys.privateKey;
  writeFileSync(join(dir, `${SUMS}.ed25519`), `${sign(null, Buffer.from(sums), signer).toString('base64')}\n`);
  return { dir, keys, key: keys.publicKey.export({ format: 'jwk' }).x! };
}

/** A --dry-run install of <version> whose server package checks run against local release files. */
function dryRunRelease(r: { dir: string; key: string }, version: string, flags: string[] = [], env: Record<string, string> = {}) {
  return dryRun(['--version', version, ...flags], { GHOSTLINK_TEST_RELEASE_DIR: posix(r.dir), GHOSTLINK_TEST_RELEASE_KEY: r.key, ...env });
}

describe.skipIf(BASH === null)('install.sh', () => {
  it('is valid bash with LF line endings, and shows its usage', () => {
    expect(bash(['-n', SCRIPT]).code).toBe(0);
    const help = bash([SCRIPT, '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/--node-ip <ipv4>/);
    expect(help.out).toMatch(/--dry-run/);
    expect(help.out).toMatch(/--allow-downgrade/);
  });

  it('never lets a non-ASCII character touch a bare $name (bash 3.2 reads it as part of the name)', () => {
    // macOS's /bin/bash 3.2 takes "$tgz…" as the variable "tgz…": unbound under set -u, so
    // the script stopped right there (the macOS CI job). ${tgz}… is read the same everywhere.
    const offenders = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /\$[A-Za-z_][A-Za-z0-9_]*[\u0080-￿]/.test(text));
    expect(offenders).toEqual([]);
  });

  it('pins the real release public key (32-byte Ed25519, base64url)', () => {
    const r = withScript('printf %s "$RELEASE_PUBLIC_KEY_B64URL"');
    expect(r.out).toBe('Hhib591tl4P4Nf9us1fB5FCXXbGOZDBHwvWIu-2FWnc');
    expect(Buffer.from(r.out, 'base64url')).toHaveLength(32);
    expect(createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: r.out }, format: 'jwk' }).asymmetricKeyType).toBe('ed25519');
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('REPLACE_WITH');
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

    it.each([
      ['0.1.0', '0.2.0', 0],
      ['0.9.0', '0.10.0', 0], // numeric, not text, order
      ['1.9.9', '2.0.0', 0],
      ['0.2.0', '0.2.0', 1],
      ['0.10.0', '0.9.0', 1],
      ['1.0.0', '0.99.99', 1],
    ])('version_lt %s %s → %i', (a, b, code) => {
      expect(withScript(`version_lt ${a} ${b}`).code).toBe(code);
    });

    it('reads the source IP of the default route and the latest tag', () => {
      expect(withScript(`printf '%s' '${ROUTE_PUBLIC}' | route_source_ip`).out.trim()).toBe('203.0.113.10');
      expect(withScript(`printf '%s' '{"tag_name":"v1.2.3"}' | latest_version_from_json`).out.trim()).toBe('1.2.3');
    });
  });

  describe('verification (real sha256 and openssl Ed25519)', () => {
    it('verify_checksum needs exactly one "<hash>  <name>" line for the name, with the file hash', () => {
      const d = temp();
      const file = join(d, 'ghostlink-server-0.1.0.tgz');
      writeFileSync(file, 'package bytes');
      const hash = createHash('sha256').update('package bytes').digest('hex');
      const ok = `${hash}  ghostlink-server-0.1.0.tgz`;
      const other = `${'0'.repeat(64)}  GhostLink-Setup-0.1.0.exe`;
      const sums = join(d, 'checksums-sha256.txt');
      const check = (content: string) => {
        writeFileSync(sums, content);
        return withScript(`verify_checksum "${posix(file)}" "${posix(sums)}" ghostlink-server-0.1.0.tgz`).code;
      };
      expect(check(`${other}\n${ok}\n`)).toBe(0);
      expect(check(ok)).toBe(0); // no final newline
      expect(check(`${'f'.repeat(64)}  ghostlink-server-0.1.0.tgz\n`)).not.toBe(0); // hash mismatch
      expect(check(`${hash.toUpperCase()}  ghostlink-server-0.1.0.tgz\n`)).not.toBe(0);
      expect(check(`${other}\n`)).not.toBe(0); // missing
      expect(check(`${hash}  ghostlink-server-0.0.9.tgz\n`)).not.toBe(0); // another version only
      expect(check(`${hash}  ghostlink-server-0.1.0.tgz.evil\n`)).not.toBe(0);
      expect(check(`${hash}  xghostlink-server-0.1.0.tgz\n`)).not.toBe(0);
      expect(check(`${hash} *ghostlink-server-0.1.0.tgz\n`)).not.toBe(0); // release.yml writes text-mode lines only
      expect(check(`${hash}   ghostlink-server-0.1.0.tgz\n`)).not.toBe(0);
      expect(check(`${ok}\n${ok}\n`)).not.toBe(0); // duplicate
      expect(check(`${'e'.repeat(64)}  ghostlink-server-0.1.0.tgz\n${ok}\n`)).not.toBe(0); // two hashes for one name
      expect(check(`${ok}\n${'e'.repeat(64)}  ghostlink-server-0.1.0.tgz\n`)).not.toBe(0);
    });

    it.skipIf(!HAS_OPENSSL)('verify_ed25519 checks a detached signature (raw or base64) against the pinned key', () => {
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
      // A valid signature by any other key fails against the pinned release key.
      expect(verify(file, raw, '$RELEASE_PUBLIC_KEY_B64URL')).not.toBe(0);
      writeFileSync(file, 'the release package, tampered');
      expect(verify(file, raw, key)).not.toBe(0);
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
      for (const f of ['ghostlink-server-0.1.0.tgz', 'checksums-sha256.txt', 'checksums-sha256.txt.ed25519', 'ghostlink-server-0.1.0.tgz.ed25519']) {
        expect(out).toContain(`+ download ${base}/${f}`);
      }
      // The checksums are authenticated before any of their lines is used.
      const sumsSig = out.indexOf('+ verify Ed25519 signature checksums-sha256.txt.ed25519');
      expect(sumsSig).toBeGreaterThan(-1);
      expect(out.indexOf('+ verify sha256 of ghostlink-server-0.1.0.tgz')).toBeGreaterThan(sumsSig);
      expect(out).toContain('+ verify Ed25519 signature ghostlink-server-0.1.0.tgz.ed25519');
      expect(out).toContain(
        'cosign verify-blob --bundle checksums-sha256.txt.sigstore.json --certificate-identity https://github.com/gestao-in7eligente/ghostlink/.github/workflows/release.yml@refs/tags/v0.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums-sha256.txt',
      );
      expect(out).not.toContain('identity-regexp');
      expect(out).toContain('+ check that the package.json version is 0.1.0');
      expect(out).toContain('+ install ghostlink-server-0.1.0.tgz into /opt/ghostlink/releases/0.1.0 and switch /opt/ghostlink/current');
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

  describe.skipIf(!HAS_OPENSSL)('the server package (--dry-run against local release files, real openssl)', () => {
    const refused = (r: ReturnType<typeof bash>, message: string | RegExp) => {
      expect(r.code, r.out).not.toBe(0);
      expect(r.err).toMatch(message);
      expect(r.out).not.toContain('Signed checksums, checksum and Ed25519 signature OK.');
    };

    it('accepts a genuine release: signed checksums, one matching line, signed package, right version', () => {
      const r = dryRunRelease(release('0.2.0'), '0.2.0');
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain('Signed checksums, checksum and Ed25519 signature OK.');
      expect(r.out).toContain('Package version 0.2.0 OK.');
      expect(r.out).toContain('GhostLink is running');
    });

    it('refuses checksums-sha256.txt signed by another key, before reading any of its lines', () => {
      const message = 'invalid Ed25519 signature for checksums-sha256.txt: download refused';
      refused(dryRunRelease(release('0.2.0', { forgeSums: true }), '0.2.0'), message);
      // Forged and wrong: the signature is what fails, the line is never used.
      refused(dryRunRelease(release('0.2.0', { forgeSums: true, sumsLine: () => '' }), '0.2.0'), message);
    });

    it('refuses checksums-sha256.txt changed after it was signed', () => {
      const r = release('0.2.0');
      const file = join(r.dir, SUMS);
      writeFileSync(file, `${readFileSync(file, 'utf8')}${'e'.repeat(64)}  ghostlink-server-0.2.0.tgz\n`);
      refused(dryRunRelease(r, '0.2.0'), 'invalid Ed25519 signature for checksums-sha256.txt: download refused');
    });

    it('refuses signed checksums without the line of this version', () => {
      refused(dryRunRelease(release('0.2.0', { sumsLine: (l) => l.replace('0.2.0', '0.1.0') }), '0.2.0'), 'checksum mismatch for ghostlink-server-0.2.0.tgz: download refused');
    });

    it('refuses signed checksums with a duplicate line for the package', () => {
      const message = 'checksum mismatch for ghostlink-server-0.2.0.tgz: download refused';
      refused(dryRunRelease(release('0.2.0', { sumsLine: (l) => `${l}\n${l}` }), '0.2.0'), message);
      refused(dryRunRelease(release('0.2.0', { sumsLine: (l) => `${l}\n${'e'.repeat(64)}  ghostlink-server-0.2.0.tgz` }), '0.2.0'), message);
    });

    it('refuses a package whose hash is not the signed one', () => {
      refused(
        dryRunRelease(release('0.2.0', { sumsLine: (l) => l.replace(/^[0-9a-f]{64}/, 'f'.repeat(64)) }), '0.2.0'),
        'checksum mismatch for ghostlink-server-0.2.0.tgz: download refused',
      );
    });

    it('refuses an older genuine package swapped in under the new name (rollback)', () => {
      const keys = generateKeyPairSync('ed25519');
      const old = release('0.1.0', { keys });
      const r = release('0.2.0', { keys });
      // Its own .ed25519 is valid for its bytes; only the signed checksums of 0.2.0 tell them apart.
      writeFileSync(join(r.dir, 'ghostlink-server-0.2.0.tgz'), readFileSync(join(old.dir, 'ghostlink-server-0.1.0.tgz')));
      writeFileSync(join(r.dir, 'ghostlink-server-0.2.0.tgz.ed25519'), readFileSync(join(old.dir, 'ghostlink-server-0.1.0.tgz.ed25519')));
      refused(dryRunRelease(r, '0.2.0'), 'checksum mismatch for ghostlink-server-0.2.0.tgz: download refused');
    });

    it('refuses a package signed by another key even with matching checksums', () => {
      const r = release('0.2.0');
      writeFileSync(join(r.dir, 'ghostlink-server-0.2.0.tgz.ed25519'), sign(null, readFileSync(join(r.dir, 'ghostlink-server-0.2.0.tgz')), generateKeyPairSync('ed25519').privateKey));
      refused(dryRunRelease(r, '0.2.0'), 'invalid Ed25519 signature for ghostlink-server-0.2.0.tgz: download refused');
    });

    it('refuses a signed package whose package.json is another version', () => {
      const r = dryRunRelease(release('0.2.0', { packageVersion: '0.1.0' }), '0.2.0');
      expect(r.code, r.out).not.toBe(0);
      expect(r.err).toContain("the package is version '0.1.0', not 0.2.0: download refused");
      expect(r.out).not.toContain('GhostLink is running');
    });
  });

  describe('no downgrade', () => {
    it('reads the installed version from $INSTALL_DIR/current (the test hook only with --dry-run)', () => {
      const installDir = (link: string) => link.replace(/\/current$/, '');
      const real = installDir(installed('0.3.0'));
      const read = (dry: number, dir: string) =>
        withScript(`INSTALL_DIR="${dir}"; DRY_RUN=${dry}; installed_version`, { GHOSTLINK_TEST_CURRENT: installed('0.9.0') }).out.trim();
      expect(read(0, real)).toBe('0.3.0');
      expect(read(1, real)).toBe('0.9.0');
      expect(read(0, installDir(installed('beta')))).toBe(''); // not a version: nothing to compare
      expect(read(0, posix(temp()))).toBe(''); // first install
    });

    it('refuses a version older than the installed one, before downloading anything', () => {
      const r = dryRun(['--version', '0.2.0'], { GHOSTLINK_TEST_CURRENT: installed('0.3.0') });
      expect(r.code, r.out).not.toBe(0);
      expect(r.err).toMatch(/GhostLink 0\.3\.0 is installed.*0\.2\.0 is older.*--allow-downgrade/);
      expect(r.out).not.toContain('Downloading');
      expect(r.out).not.toContain('+ systemctl restart');
    });

    it('compares versions as numbers (0.9.0 is older than 0.10.0)', () => {
      expect(dryRun(['--version', '0.9.0'], { GHOSTLINK_TEST_CURRENT: installed('0.10.0') }).code).not.toBe(0);
      expect(dryRun(['--version', '0.10.0'], { GHOSTLINK_TEST_CURRENT: installed('0.9.0') }).code).toBe(0);
    });

    it('refuses an older "latest" release too (a rolled-back tag)', () => {
      const r = dryRun([], { GHOSTLINK_TEST_CURRENT: installed('0.3.0') }); // latest = 0.1.0
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/--allow-downgrade/);
    });

    it('installs an older version with --allow-downgrade', () => {
      const r = dryRun(['--version', '0.2.0', '--allow-downgrade'], { GHOSTLINK_TEST_CURRENT: installed('0.3.0') });
      expect(r.code, r.err).toBe(0);
      expect(r.err).toMatch(/downgrading GhostLink from 0\.3\.0 to 0\.2\.0/);
      expect(r.out).toContain('+ install ghostlink-server-0.2.0.tgz into /opt/ghostlink/releases/0.2.0');
    });

    it('re-installs the same version (idempotent update) and upgrades', () => {
      const same = dryRun(['--version', '0.2.0'], { GHOSTLINK_TEST_CURRENT: installed('0.2.0') });
      expect(same.code, same.err).toBe(0);
      expect(same.out).toContain('Installed version: 0.2.0');
      expect(same.out).toContain('+ install ghostlink-server-0.2.0.tgz into /opt/ghostlink/releases/0.2.0');
      const up = dryRun(['--version', '0.2.0'], { GHOSTLINK_TEST_CURRENT: installed('0.1.0') });
      expect(up.code, up.err).toBe(0);
      expect(up.out).toContain('Installed version: 0.1.0');
    });

    it.skipIf(!HAS_OPENSSL)('re-installs the same genuine release with the real checks', () => {
      const r = dryRunRelease(release('0.2.0'), '0.2.0', [], { GHOSTLINK_TEST_CURRENT: installed('0.2.0') });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain('Package version 0.2.0 OK.');
    });
  });
});
