// apps/server/docker/entrypoint.sh: the container's environment variables become the
// `ghostlink-server start` flags. Proxy mode (spec §8.6) turns on by itself on Railway
// once the service has a TCP proxy (RAILWAY_TCP_PROXY_DOMAIN + RAILWAY_TCP_PROXY_PORT),
// with GHOSTLINK_PROXY_ADDRESS, or with GHOSTLINK_PROXY_MODE=1 and a public address.
// The script runs under a POSIX sh with a fake `node` first on PATH that prints its argv.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../apps/server/docker/entrypoint.sh', import.meta.url)).replace(/\\/g, '/');

/** Git's sh on Windows (never WSL's), the system sh elsewhere (dash on Debian, like the image). */
function findSh(): string | null {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files (x86)\\Git\\bin\\sh.exe'] : ['/bin/sh', '/usr/bin/sh'];
  return candidates.find((c) => existsSync(c)) ?? null;
}
const SH = findSh();

const fakeBin = mkdtempSync(join(tmpdir(), 'ghostlink-entrypoint-'));
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));
writeFileSync(
  join(fakeBin, 'node'),
  '#!/bin/sh\nfor a in "$@"; do printf \'arg:%s\\n\' "$a"; done\nprintf \'livekit:%s\\n\' "${GHOSTLINK_LIVEKIT_BIN:-}"\n',
);
chmodSync(join(fakeBin, 'node'), 0o755);

/** Variables the test machine may have that would leak into a run. */
const SCRUBBED = /^(GHOSTLINK_|RAILWAY_)/i;

function run(env: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUBBED.test(k)) base[k] = v;
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  base[pathKey] = `${fakeBin}${sep}${base[pathKey] ?? ''}`;
  const r = spawnSync(SH!, [SCRIPT], { encoding: 'utf8', env: { ...base, ...env }, timeout: 30_000 });
  const lines = r.stdout.split(/\r?\n/);
  const args = lines.filter((l) => l.startsWith('arg:')).map((l) => l.slice(4));
  const livekit = lines.find((l) => l.startsWith('livekit:'))?.slice(8) ?? null;
  return { code: r.status, args, livekit, err: r.stderr };
}

/** The value after `flag`, or every value when it repeats. */
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe.skipIf(!SH)('docker entrypoint (spec §8.6)', () => {
  it('is valid sh', () => {
    expect(spawnSync(SH!, ['-n', SCRIPT]).status).toBe(0);
  });

  it('defaults: start the bundled CLI with /data and port 7700, no proxy, no voice', () => {
    const r = run({});
    expect(r.code, r.err).toBe(0);
    expect(r.args).toEqual(['/opt/ghostlink/dist/cli.js', 'start', '--data', '/data', '--port', '7700']);
    expect(r.livekit).toBe('');
  });

  it('what the desktop app sets on Railway, once the service has a TCP proxy: proxy mode with voice', () => {
    const r = run({
      GHOSTLINK_NAME: 'Meu servidor',
      GHOSTLINK_VOICE: '1',
      GHOSTLINK_PORT: '7700',
      PORT: '7700',
      GHOSTLINK_DATA: '/data',
      RAILWAY_TCP_PROXY_DOMAIN: 'altaria.proxy.rlwy.net',
      RAILWAY_TCP_PROXY_PORT: '25889',
      RAILWAY_TCP_APPLICATION_PORT: '7700',
    });
    expect(r.code, r.err).toBe(0);
    expect(values(r.args, '--proxy')).toEqual(['altaria.proxy.rlwy.net:25889']);
    expect(values(r.args, '--port')).toEqual(['7700']);
    expect(values(r.args, '--name')).toEqual(['Meu servidor']);
    // The CLI makes the proxy the public address; the node IP comes from its name.
    expect(values(r.args, '--public-address')).toEqual([]);
    expect(values(r.args, '--node-ip')).toEqual([]);
    expect(r.livekit).toBe('/opt/livekit/livekit-server');
    expect(r.err).toBe('');
  });

  it('Railway without a TCP proxy yet: no proxy mode', () => {
    expect(values(run({ RAILWAY_TCP_PROXY_DOMAIN: 'altaria.proxy.rlwy.net' }).args, '--proxy')).toEqual([]);
    expect(values(run({ RAILWAY_TCP_PROXY_PORT: '25889' }).args, '--proxy')).toEqual([]);
  });

  it('GHOSTLINK_PUBLIC_ADDRESS still decides what goes in invites', () => {
    const r = run({ RAILWAY_TCP_PROXY_DOMAIN: 'altaria.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '25889', GHOSTLINK_PUBLIC_ADDRESS: 'chat.example.com:25889,66.33.22.220:25889' });
    expect(values(r.args, '--proxy')).toEqual(['altaria.proxy.rlwy.net:25889']);
    expect(values(r.args, '--public-address')).toEqual(['chat.example.com:25889', '66.33.22.220:25889']);
  });

  it('GHOSTLINK_PROXY_ADDRESS wins over Railway\'s variables (other hosts, or a custom domain)', () => {
    const r = run({ GHOSTLINK_PROXY_ADDRESS: 'tcp.example.net:30000', RAILWAY_TCP_PROXY_DOMAIN: 'altaria.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '25889' });
    expect(values(r.args, '--proxy')).toEqual(['tcp.example.net:30000']);
  });

  it('GHOSTLINK_PROXY_MODE=1 takes the first public address as the proxy; without one it stops', () => {
    const r = run({ GHOSTLINK_PROXY_MODE: '1', GHOSTLINK_PUBLIC_ADDRESS: 'tcp.example.net:30000,backup.example.net:30000' });
    expect(values(r.args, '--proxy')).toEqual(['tcp.example.net:30000']);
    const missing = run({ GHOSTLINK_PROXY_MODE: '1' });
    expect(missing.code).not.toBe(0);
    expect(missing.err).toMatch(/GHOSTLINK_PROXY_ADDRESS/);
    expect(missing.args).toEqual([]);
  });

  it('GHOSTLINK_PROXY_MODE=0 keeps proxy mode off, even on Railway', () => {
    const r = run({ GHOSTLINK_PROXY_MODE: '0', RAILWAY_TCP_PROXY_DOMAIN: 'altaria.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '25889', GHOSTLINK_PROXY_ADDRESS: 'x.example:1' });
    expect(values(r.args, '--proxy')).toEqual([]);
  });

  it('listens where Railway\'s proxy forwards when GHOSTLINK_PORT is not set, and warns on a mismatch', () => {
    expect(values(run({ RAILWAY_TCP_APPLICATION_PORT: '8443' }).args, '--port')).toEqual(['8443']);
    const mismatch = run({ GHOSTLINK_PORT: '7700', RAILWAY_TCP_APPLICATION_PORT: '8443' });
    expect(values(mismatch.args, '--port')).toEqual(['7700']);
    expect(mismatch.err).toMatch(/forwards to port 8443/);
  });

  it('keeps the explicit variables for other hosts', () => {
    const r = run({ GHOSTLINK_DATA: '/srv/gl', GHOSTLINK_PORT: '7710', GHOSTLINK_NODE_IP: '203.0.113.9', GHOSTLINK_PUBLIC_ADDRESS: 'vps.example.com:7710' });
    expect(r.args).toEqual([
      '/opt/ghostlink/dist/cli.js', 'start', '--data', '/srv/gl', '--port', '7710', '--node-ip', '203.0.113.9', '--public-address', 'vps.example.com:7710',
    ]);
  });
});
