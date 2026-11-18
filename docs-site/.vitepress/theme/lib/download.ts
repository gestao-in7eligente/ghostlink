// Download button (spec §16): the GitHub API's releases/latest names the current Windows
// installer. It is the site's only call to a third party, made from the visitor's browser.
// Imported module by module (not through the @ghostlink/shared index) so the page bundles only this.
import {
  LATEST_RELEASE_API_URL,
  RELEASES_PAGE_URL,
  isReleaseVersion,
  releaseDownloadUrl,
  linuxAppImageName,
  windowsInstallerName,
} from '../../../../packages/shared/src/release.js';

/** Where every button falls back to when the API cannot be used. */
export const LATEST_RELEASE_PAGE_URL = `${RELEASES_PAGE_URL}/latest`;

export interface Download {
  version: string;
  /** Always `https://github.com/<repo>/releases/download/v<version>/<installer name>`. */
  url: string;
  /** Bytes, or null when the API did not give a believable size. */
  size: number | null;
}
export type WindowsDownload = Download;
export type DownloadOs = 'windows' | 'linux';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The installer of a `releases/latest` answer for one OS, or null if anything about it is off. */
export function pickDownload(release: unknown, os: DownloadOs): Download | null {
  if (!isRecord(release) || release.draft === true || release.prerelease === true) return null;
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  if (!isReleaseVersion(version)) return null;
  const name = os === 'linux' ? linuxAppImageName(version) : windowsInstallerName(version);
  const assets = Array.isArray(release.assets) ? (release.assets as unknown[]) : [];
  const asset = assets.find((a): a is Record<string, unknown> => isRecord(a) && a.name === name);
  if (!asset) return null;
  // The link is built here from constants; the API's own URL only has to agree with it.
  const url = releaseDownloadUrl(version, name);
  if (asset.browser_download_url !== url) return null;
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null;
  return { version, url, size };
}

export const pickWindowsDownload = (release: unknown): Download | null => pickDownload(release, 'windows');
export const pickLinuxDownload = (release: unknown): Download | null => pickDownload(release, 'linux');

/** Asks the GitHub API for the latest release. Resolves null on any failure (offline, rate limit, no release yet). */
export async function fetchLatestDownload(os: DownloadOs, fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<Download | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_API_URL, {
      headers: { accept: 'application/vnd.github+json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return pickDownload(await res.json(), os);
  } catch {
    return null;
  }
}

export const fetchLatestWindowsDownload = (fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<Download | null> =>
  fetchLatestDownload('windows', fetchImpl, timeoutMs);
export const fetchLatestLinuxDownload = (fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<Download | null> =>
  fetchLatestDownload('linux', fetchImpl, timeoutMs);

export interface VisitorPlatform {
  userAgent: string;
  userAgentData?: { platform?: string } | undefined;
}

/** Windows and Linux have installers; visitors on anything else (macOS, phones) are told so. */
export function isWindowsVisitor(nav: VisitorPlatform): boolean {
  const platform = nav.userAgentData?.platform;
  if (typeof platform === 'string' && platform !== '') return platform === 'Windows';
  return /\bWindows NT\b/.test(nav.userAgent);
}

export function isLinuxVisitor(nav: VisitorPlatform): boolean {
  const platform = nav.userAgentData?.platform;
  // Android reports "Android" here and "Linux" in its user agent: it is not a desktop Linux.
  if (typeof platform === 'string' && platform !== '') return platform === 'Linux';
  return /\bLinux\b/.test(nav.userAgent) && !/\bAndroid\b/.test(nav.userAgent);
}
