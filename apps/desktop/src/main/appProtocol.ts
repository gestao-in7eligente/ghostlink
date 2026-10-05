import { protocol } from 'electron';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isFileRequest } from './attachments/fileRoute.js';
import { isAvatarRequest } from './avatars/avatarRoute.js';

export const APP_SCHEME = 'app';
export const APP_HOST = 'ghostlink';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * spec §12. What really confines the page is the session pin and never rendering user content as HTML.
 * 'wasm-unsafe-eval' lets the bundled noise suppressors compile WebAssembly (noise suppression
 * spec 2026-10-01 §3); JavaScript eval and new Function stay blocked.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' https: blob: data:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https: wss:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
].join('; ');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

/** Step 3 of the bootstrap: must run before app ready. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    // `stream`: attachments' video and audio play from app:// with Range requests (anexos §4).
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Maps an app://ghostlink/… URL to a path inside rendererDir (`/` → index.html),
 * or null when the URL is for another host or tries to leave the directory
 * (`..`, encoded `%2e%2e`, `%2f`, `%5c`, NUL bytes).
 */
export function resolveAppPath(rendererDir: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const root = resolve(rendererDir);
  if (pathname === '/' || pathname === '') return join(root, 'index.html');
  const target = resolve(root, `.${pathname}`);
  return isInside(root, target) ? target : null;
}

/** The real path of an existing regular file that is still inside root after resolving links; otherwise null. */
function realFileInside(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    if (!isInside(realpathSync(root), real) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * The app:// handler (spec §12): serves only regular files from inside rendererDir,
 * falls back to index.html for anything else inside it (client-side routes), and
 * answers 404 for other hosts and escape attempts. Sync fs calls also work inside asar.
 */
export function createAppProtocolHandler(rendererDir: string): (request: Request) => Response {
  const root = resolve(rendererDir);
  const index = join(root, 'index.html');
  const headers = { 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
  return (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers });
    const target = resolveAppPath(root, request.url);
    const file = target === null ? null : realFileInside(root, target) ?? realFileInside(root, index);
    if (file === null) return new Response(null, { status: 404, headers });
    const contentType = MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const body = request.method === 'HEAD' ? null : readFileSync(file);
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': contentType } });
  };
}

/** Routes served next to the renderer's files. */
export interface AppRoutes {
  /** app://ghostlink/_avatar/<hash>: profile photos (avatars/avatarRoute.ts). */
  avatar?: (request: Request) => Promise<Response>;
  /** app://ghostlink/_file/<serverId>/<fileId>: server attachments (attachments/fileRoute.ts). */
  file?: (request: Request) => Promise<Response>;
  /** app://ghostlink/_dmfile/<hash>: direct-message files (the DM engine). */
  dmFile?: (request: Request) => Promise<Response>;
}

/** The path prefix of direct-message files (anexos §4). */
export const DM_FILE_ROUTE_PREFIX = '/_dmfile';

/** True for app://ghostlink/_dmfile and anything under it. */
export function isDmFileRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST && (path === DM_FILE_ROUTE_PREFIX || path.startsWith(`${DM_FILE_ROUTE_PREFIX}/`));
}

/**
 * The renderer's files plus the app's own routes. Every path under /_avatar, /_file and /_dmfile
 * belongs to its route (a 404 there, never index.html), and they work from the dev server's page
 * too: an http://localhost page may load app:// images (measured with Electron 44).
 */
export function createAppRequestHandler(rendererDir: string, routes: AppRoutes = {}): (request: Request) => Response | Promise<Response> {
  const files = createAppProtocolHandler(rendererDir);
  const missing = () => new Response(null, { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
  return (request) => {
    if (isAvatarRequest(request.url)) return routes.avatar ? routes.avatar(request) : missing();
    if (isFileRequest(request.url)) return routes.file ? routes.file(request) : missing();
    if (isDmFileRequest(request.url)) return routes.dmFile ? routes.dmFile(request) : missing();
    return files(request);
  };
}

/**
 * Step 5 of the bootstrap: serve the built renderer at app://ghostlink/ (never file://). `routes`
 * is read at each request, so a route may join later; the handler is returned for main's own use
 * ("Baixar" reads an attachment through it).
 */
export function registerAppProtocol(rendererDir: string, routes: AppRoutes = {}): (request: Request) => Response | Promise<Response> {
  const handler = createAppRequestHandler(rendererDir, routes);
  protocol.handle(APP_SCHEME, handler);
  return handler;
}
