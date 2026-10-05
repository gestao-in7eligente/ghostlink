// Download button (spec §16): the GitHub API's releases/latest names the current Windows
// installer. It is the site's only call to a third party, made from the visitor's browser.
// Imported module by module (not through the @ghostlink/shared index) so the page bundles only this.
import {
  LATEST_RELEASE_API_URL,
  RELEASES_PAGE_URL,
  isReleaseVersion,
  releaseDownloadUrl,
  windowsInstallerName,
} from '../../../../packages/shared/src/release.js';

/** Where every button falls back to when the API cannot be used. */
export const LATEST_RELEASE_PAGE_URL = `${RELEASES_PAGE_URL}/latest`;

export interface WindowsDownload {
  version: string;
  /** Always `https://github.com/<repo>/releases/download/v<version>/GhostLink-Setup-<version>.exe`. */
  url: string;
  /** Bytes, or null when the API did not give a believable size. */
  size: number | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The Windows installer of a `releases/latest` answer, or null if anything about it is off. */
export function pickWindowsDownload(release: unknown): WindowsDownload | null {
  if (!isRecord(release) || release.draft === true || release.prerelease === true) return null;
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  if (!isReleaseVersion(version)) return null;
  const name = windowsInstallerName(version);
  const assets = Array.isArray(release.assets) ? (release.assets as unknown[]) : [];
  const asset = assets.find((a): a is Record<string, unknown> => isRecord(a) && a.name === name);
  if (!asset) return null;
  // The link is built here from constants; the API's own URL only has to agree with it.
  const url = releaseDownloadUrl(version, name);
  if (asset.browser_download_url !== url) return null;
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null;
  return { version, url, size };
}

/** Asks the GitHub API for the latest release. Resolves null on any failure (offline, rate limit, no release yet). */
export async function fetchLatestWindowsDownload(fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<WindowsDownload | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_API_URL, {
      headers: { accept: 'application/vnd.github+json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return pickWindowsDownload(await res.json());
  } catch {
    return null;
  }
}

export interface VisitorPlatform {
  userAgent: string;
  userAgentData?: { platform?: string } | undefined;
}

/** v0.1 ships a Windows installer only; other visitors are told so. */
export function isWindowsVisitor(nav: VisitorPlatform): boolean {
  const platform = nav.userAgentData?.platform;
  if (typeof platform === 'string' && platform !== '') return platform === 'Windows';
  return /\bWindows NT\b/.test(nav.userAgent);
}
