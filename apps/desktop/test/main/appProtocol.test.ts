import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../helpers/tempDir.js';

const electron = vi.hoisted(() => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));
vi.mock('electron', () => electron);

const { APP_ORIGIN, CONTENT_SECURITY_POLICY, createAppProtocolHandler, registerAppProtocol, registerAppSchemePrivileges, resolveAppPath } =
  await import('../../src/main/appProtocol.js');

const tmp = useTempDir();
const SECRET = 'TOP SECRET';
let renderer: string;

beforeEach(() => {
  renderer = join(tmp.path, 'renderer');
  mkdirSync(join(renderer, 'assets'), { recursive: true });
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>GhostLink</title>');
  writeFileSync(join(renderer, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(renderer, 'assets', 'inter.woff2'), 'font');
  writeFileSync(join(renderer, 'assets', 'rnnoise.wasm'), 'wasm');
  writeFileSync(join(tmp.path, 'secret.txt'), SECRET);
  mkdirSync(join(tmp.path, 'outside'));
  writeFileSync(join(tmp.path, 'outside', 'secret.txt'), SECRET);
});

const get = async (url: string, method = 'GET') => {
  const res = createAppProtocolHandler(renderer)(new Request(url, { method }));
  return { status: res.status, headers: res.headers, body: method === 'HEAD' ? '' : await res.text() };
};

describe('resolveAppPath', () => {
  it('maps the app origin into the renderer directory', () => {
    expect(APP_ORIGIN).toBe('app://ghostlink');
    expect(resolveAppPath(renderer, 'app://ghostlink/')).toBe(join(renderer, 'index.html'));
    expect(resolveAppPath(renderer, 'app://ghostlink/assets/app.js?v=1#x')).toBe(join(renderer, 'assets', 'app.js'));
  });

  it.each([
    ['another host', 'app://evil/index.html'],
    ['another scheme', 'file:///etc/passwd'],
    ['an encoded slash after ..', 'app://ghostlink/..%2fsecret.txt'],
    ['an encoded ../ pair', 'app://ghostlink/assets/..%2f..%2fsecret.txt'],
    ['a NUL byte', 'app://ghostlink/index.html%00.js'],
    ['broken percent-encoding', 'app://ghostlink/%E0%A4%A'],
    ['not a URL', 'nonsense'],
  ])('refuses %s', (_label, url) => {
    expect(resolveAppPath(renderer, url)).toBeNull();
  });
});

describe('createAppProtocolHandler (spec §12)', () => {
  it('serves index.html at / with the CSP and nosniff headers', async () => {
    const res = await get('app://ghostlink/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>GhostLink</title>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    // WebAssembly may compile (the noise suppressors); JavaScript eval stays blocked.
    expect(CONTENT_SECURITY_POLICY.split('; ')).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves assets with their content type', async () => {
    expect((await get('app://ghostlink/assets/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await get('app://ghostlink/assets/inter.woff2')).headers.get('content-type')).toBe('font/woff2');
    expect((await get('app://ghostlink/assets/rnnoise.wasm')).headers.get('content-type')).toBe('application/wasm');
  });

  it('falls back to index.html for client-side routes and missing files', async () => {
    for (const path of ['/servers/abc', '/assets/missing.js', '/assets']) {
      const res = await get(`app://ghostlink${path}`);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain('<title>GhostLink</title>');
    }
  });

  it.each([
    'app://ghostlink/../secret.txt',
    'app://ghostlink/%2e%2e/secret.txt',
    'app://ghostlink/..%2fsecret.txt',
    'app://ghostlink/..%5csecret.txt',
    'app://ghostlink/assets/..%5c..%5csecret.txt',
    'app://ghostlink/%2e%2e%2f%2e%2e%2fsecret.txt',
    'app://ghostlink//secret.txt',
  ])('never serves a file outside the directory: %s', async (url) => {
    const res = await get(url);
    expect(res.body).not.toContain(SECRET);
  });

  it('does not follow a link that points outside the directory', async () => {
    symlinkSync(join(tmp.path, 'outside'), join(renderer, 'link'), 'junction');
    const res = await get('app://ghostlink/link/secret.txt');
    expect(res.body).not.toContain(SECRET);
  });

  it('answers 404 for another host and 405 for anything but GET/HEAD', async () => {
    expect((await get('app://evil/index.html')).status).toBe(404);
    expect((await get('app://ghostlink/', 'POST')).status).toBe(405);
    const head = await get('app://ghostlink/', 'HEAD');
    expect(head.status).toBe(200);
  });
});

describe('Electron registration', () => {
  it('registers app:// as a standard, secure, fetch-capable scheme', () => {
    registerAppSchemePrivileges();
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
  });

  it('installs the handler for the app scheme', async () => {
    registerAppProtocol(renderer);
    const [scheme, handler] = electron.protocol.handle.mock.calls.at(-1) as [string, (r: Request) => Response];
    expect(scheme).toBe('app');
    expect(await handler(new Request('app://ghostlink/assets/app.js')).text()).toBe('console.log(1)');
  });
});
