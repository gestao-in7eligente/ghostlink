import { app, session, type WebContents } from 'electron';

/**
 * `scheme://host[:port]` for app:, http: and https: URLs; null for anything else.
 * Node's URL reports the origin of a custom scheme as "null", so it is rebuilt
 * from protocol + host; the whole URL is never compared (its path and hash change).
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['app:', 'http:', 'https:'].includes(parsed.protocol) || parsed.host === '') return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/** Permission requests (spec §12): only `media` (mic, camera, getDisplayMedia), only for the app's own page. */
export function allowPermissionRequest(permission: string, requestingUrl: string, appOrigin: string): boolean {
  return permission === 'media' && originOf(requestingUrl) === appOrigin;
}

/** Permission checks (spec §12): `media` and `speaker-selection`, only for the app's own origin. */
export function allowPermissionCheck(permission: string, requestingOrigin: string, appOrigin: string): boolean {
  return (permission === 'media' || permission === 'speaker-selection') && originOf(requestingOrigin) === appOrigin;
}

/** Applied to every webContents ever created (spec §12). */
export function hardenWebContents(contents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/**
 * Step 5 of the bootstrap: navigation and window guards for all webContents,
 * the permission policy and the download rule. `appOrigin` is app://ghostlink,
 * or the dev server's origin in development.
 */
export function installSecurity(opts: { appOrigin: string }): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowPermissionRequest(permission, details.requestingUrl || webContents.getURL(), opts.appOrigin));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => allowPermissionCheck(permission, requestingOrigin, opts.appOrigin));
  ses.on('will-download', (event, _item, webContents) => {
    // Only the app page may download. No save path is ever set, so Electron always
    // shows the save dialog, and a downloaded file is never opened automatically.
    if (originOf(webContents.getURL()) !== opts.appOrigin) event.preventDefault();
  });
}
