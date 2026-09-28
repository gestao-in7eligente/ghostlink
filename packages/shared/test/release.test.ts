import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/encoding.js';
import {
  RELEASE_PUBLIC_KEY,
  RELEASE_REPO,
  RELEASE_SIGNATURE_SUFFIX,
  RELEASES_PAGE_URL,
  LATEST_RELEASE_API_URL,
  SITE_URL,
  ed25519SpkiDer,
  isReleaseVersion,
  releaseDownloadUrl,
  releasePublicKeyBytes,
  releaseTagUrl,
  serverPackageName,
  windowsInstallerName,
} from '../src/release.js';

describe('release constants (spec §15)', () => {
  it('points at the public repository and its GitHub Pages site', () => {
    expect(RELEASE_REPO).toEqual({ owner: 'gestao-in7eligente', repo: 'ghostlink' });
    expect(RELEASES_PAGE_URL).toBe('https://github.com/gestao-in7eligente/ghostlink/releases');
    expect(LATEST_RELEASE_API_URL).toBe('https://api.github.com/repos/gestao-in7eligente/ghostlink/releases/latest');
    expect(SITE_URL).toBe('https://gestao-in7eligente.github.io/ghostlink/');
  });

  it('embeds a real 32-byte Ed25519 public key in canonical base64url', () => {
    expect(RELEASE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = releasePublicKeyBytes();
    expect(raw).toHaveLength(32);
    expect(toBase64Url(raw)).toBe(RELEASE_PUBLIC_KEY);
    expect(raw.some((b) => b !== 0)).toBe(true);
    expect(RELEASE_SIGNATURE_SUFFIX).toBe('.ed25519');
  });

  it('wraps a raw key in the RFC 8410 SPKI header', () => {
    const der = ed25519SpkiDer(new Uint8Array(32).fill(7));
    expect(der).toHaveLength(44);
    expect(toBase64Url(der.subarray(0, 12))).toBe(toBase64Url(fromBase64Url('MCowBQYDK2VwAyEA')));
    expect([...der.subarray(12)]).toEqual(new Array(32).fill(7));
    expect(() => ed25519SpkiDer(new Uint8Array(31))).toThrow();
  });
});

describe('isReleaseVersion', () => {
  it.each(['0.1.0', '0.1.1', '1.0.0', '10.20.30', '0.0.0'])('accepts the stable version %s', (v) => {
    expect(isReleaseVersion(v)).toBe(true);
  });

  it.each([
    ['a pre-release (allowPrerelease is false)', '0.3.0-rc.1'],
    ['build metadata', '0.1.0+build'],
    ['a v prefix', 'v0.1.0'],
    ['leading zeros', '0.01.0'],
    ['two parts', '0.1'],
    ['path traversal', '0.1.0/../../x'],
    ['whitespace', ' 0.1.0'],
    ['a huge number', '9999999.0.0'],
    ['empty', ''],
  ])('rejects %s', (_label, v) => {
    expect(isReleaseVersion(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, {}, ['0.1.0']]) expect(isReleaseVersion(v)).toBe(false);
  });
});

describe('release file names and URLs', () => {
  it('names the artifacts after electron-builder and the server package', () => {
    expect(windowsInstallerName('0.1.0')).toBe('GhostLink-Setup-0.1.0.exe');
    expect(serverPackageName('0.1.0')).toBe('ghostlink-server-0.1.0.tgz');
    expect(() => windowsInstallerName('0.1.0-rc.1')).toThrow();
    expect(() => serverPackageName('../x')).toThrow();
  });

  it('builds download URLs under the tagged release only', () => {
    expect(releaseDownloadUrl('0.1.1', 'GhostLink-Setup-0.1.1.exe.ed25519')).toBe(
      'https://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.1/GhostLink-Setup-0.1.1.exe.ed25519',
    );
    expect(releaseTagUrl('0.1.1')).toBe('https://github.com/gestao-in7eligente/ghostlink/releases/tag/v0.1.1');
  });

  it.each([['../latest.yml'], ['a/b'], ['a b'], ['%2e%2e'], [''], ['x'.repeat(200)], ['?q=1'], ['#frag']])(
    'refuses the file name %j',
    (name) => {
      expect(() => releaseDownloadUrl('0.1.0', name)).toThrow();
    },
  );

  it('refuses a version that is not a stable release', () => {
    expect(() => releaseDownloadUrl('0.1.0/../../evil', 'a.exe')).toThrow();
    expect(() => releaseTagUrl('latest')).toThrow();
  });
});
