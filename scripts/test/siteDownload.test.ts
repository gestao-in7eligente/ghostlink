import { LATEST_RELEASE_API_URL, RELEASES_PAGE_URL } from '@ghostlink/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  LATEST_RELEASE_PAGE_URL,
  fetchLatestWindowsDownload,
  isWindowsVisitor,
  pickWindowsDownload,
} from '../../docs-site/.vitepress/theme/lib/download.js';

// Download page (spec §16): releases/latest from the GitHub API picks the Windows installer; any
// doubt falls back to the releases page. The link must always be this repository's tagged asset.
const DL = 'https://github.com/gestao-in7eligente/ghostlink/releases/download';
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.1.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'latest.yml', size: 350, browser_download_url: `${DL}/v0.1.0/latest.yml` },
    { name: 'GhostLink-Setup-0.1.0.exe', size: 98_765_432, browser_download_url: `${DL}/v0.1.0/GhostLink-Setup-0.1.0.exe` },
    { name: 'GhostLink-Setup-0.1.0.exe.ed25519', size: 64, browser_download_url: `${DL}/v0.1.0/GhostLink-Setup-0.1.0.exe.ed25519` },
  ],
  ...over,
});

describe('pickWindowsDownload', () => {
  it('finds the NSIS installer of the latest release', () => {
    expect(pickWindowsDownload(release())).toEqual({
      version: '0.1.0',
      url: `${DL}/v0.1.0/GhostLink-Setup-0.1.0.exe`,
      size: 98_765_432,
    });
  });

  it('ignores drafts, pre-releases and tags that are not stable versions', () => {
    expect(pickWindowsDownload(release({ draft: true }))).toBeNull();
    expect(pickWindowsDownload(release({ prerelease: true }))).toBeNull();
    for (const tag_name of ['0.1.0', 'v0.1', 'v0.3.0-rc.1', 'v01.0.0', 'v0.1.0/../../x', '', 7]) {
      expect(pickWindowsDownload(release({ tag_name })), String(tag_name)).toBeNull();
    }
  });

  it('needs the installer named for that exact version', () => {
    const renamed = release().assets.map((a) => ({ ...a, name: a.name.replace('0.1.0', '0.0.9') }));
    expect(pickWindowsDownload(release({ assets: renamed }))).toBeNull();
    expect(pickWindowsDownload(release({ assets: [] }))).toBeNull();
    expect(pickWindowsDownload(release({ assets: 'x' }))).toBeNull();
    expect(pickWindowsDownload(release({ tag_name: 'v0.2.0' }))).toBeNull();
  });

  it('only links to this repository, over https, for that tag', () => {
    for (const url of [
      'https://evil.example/GhostLink-Setup-0.1.0.exe',
      'http://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.0/GhostLink-Setup-0.1.0.exe',
      `${DL.replace('gestao-in7eligente', 'someone-else')}/v0.1.0/GhostLink-Setup-0.1.0.exe`,
      `${DL}/v0.0.9/GhostLink-Setup-0.1.0.exe`,
      'javascript:alert(1)',
      undefined,
    ]) {
      const assets = [{ name: 'GhostLink-Setup-0.1.0.exe', size: 1, browser_download_url: url }];
      expect(pickWindowsDownload(release({ assets })), String(url)).toBeNull();
    }
  });

  it('shows no size it cannot trust', () => {
    for (const size of [0, -1, 1.5, '100', null, Number.MAX_VALUE]) {
      const assets = [{ name: 'GhostLink-Setup-0.1.0.exe', size, browser_download_url: `${DL}/v0.1.0/GhostLink-Setup-0.1.0.exe` }];
      expect(pickWindowsDownload(release({ assets }))?.size, String(size)).toBeNull();
    }
  });

  it('survives anything the API may answer', () => {
    for (const body of [null, undefined, 'v0.1.0', 42, [], {}, { message: 'API rate limit exceeded' }]) {
      expect(pickWindowsDownload(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('fetchLatestWindowsDownload', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('asks the GitHub API anonymously, without cookies or referrer', async () => {
    const fetchImpl = vi.fn(async () => ok(release()));
    await expect(fetchLatestWindowsDownload(fetchImpl)).resolves.toMatchObject({ version: '0.1.0' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_API_URL);
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(new Headers(init.headers).get('accept')).toBe('application/vnd.github+json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers null (so the page links to the releases page) on any failure', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response('rate limited', { status: 403 }),
      async () => new Response('not found', { status: 404 }), // no release yet
      async () => new Response('{not json', { status: 200 }),
      async () => ok({ tag_name: 'v0.1.0', assets: [] }),
      async () => Promise.reject(new TypeError('offline')),
    ];
    for (const fetchImpl of cases) {
      await expect(fetchLatestWindowsDownload(fetchImpl)).resolves.toBeNull();
    }
  });

  it('gives up after the timeout', async () => {
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
      });
    await expect(fetchLatestWindowsDownload(hanging, 20)).resolves.toBeNull();
  });

  it('falls back to the latest release page of this repository', () => {
    expect(LATEST_RELEASE_PAGE_URL).toBe(`${RELEASES_PAGE_URL}/latest`);
  });
});

describe('isWindowsVisitor', () => {
  it('recognizes Windows from the user agent or client hints', () => {
    expect(isWindowsVisitor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' })).toBe(true);
    expect(isWindowsVisitor({ userAgent: 'x', userAgentData: { platform: 'Windows' } })).toBe(true);
    expect(isWindowsVisitor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })).toBe(false);
    expect(isWindowsVisitor({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false);
    expect(isWindowsVisitor({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe(false);
    expect(isWindowsVisitor({ userAgent: 'Mozilla/5.0 (Macintosh)', userAgentData: { platform: 'macOS' } })).toBe(false);
  });
});
