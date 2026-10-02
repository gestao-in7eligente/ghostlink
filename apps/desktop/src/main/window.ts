// The main window's options and the application menu, as plain data (tested without Electron).
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions, NativeImage } from 'electron';
import { APP_ID, APP_NAME } from '@ghostlink/shared';

/**
 * The Windows AppUserModelID: the installed app's own, or a separate one for development and
 * test runs, whose Start-menu shortcut (Electron creates one to show toasts) must never stand in
 * for the installed app's and give its taskbar button Electron's icon.
 */
export function appUserModelId(packaged: boolean): string {
  return packaged ? APP_ID : `${APP_ID}.dev`;
}

/** The system buttons over the page's title bar: --bg-rail and --text-icon (tokens.css). */
export const TITLE_BAR = { color: '#2c2d32', symbolColor: '#c5c6ca', height: 32 } as const;

/**
 * The renderer runs sandboxed and isolated. DevTools exist only in development: in the
 * packaged app nobody can open a console in the page that holds the session.
 * `icon` is the ghost for the taskbar and title bar: in development the process is
 * electron.exe, whose embedded icon is Electron's.
 * Windows and Linux get Discord's title bar: the page draws it (TitleBar, 32 px, the
 * rail color) and the system keeps only its minimize/maximize/close buttons over it.
 */
export function mainWindowOptions(opts: { preload: string; packaged: boolean; platform: NodeJS.Platform; icon?: NativeImage }): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: TITLE_BAR.color,
    title: APP_NAME,
    ...(opts.icon ? { icon: opts.icon } : {}),
    ...(opts.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...TITLE_BAR } }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !opts.packaged,
      spellcheck: false,
      // Remote voice plays without a click first (spec §8.4); room.startAudio() covers the rest.
      autoplayPolicy: 'no-user-gesture-required',
      // The microphone gate runs on renderer timers: they must keep their pace while a game has focus.
      backgroundThrottling: false,
    },
  };
}

/**
 * The application menu for Menu.setApplicationMenu: `undefined` keeps Electron's default
 * (development: reload, DevTools); `null` removes it (packaged on Windows and Linux, where
 * Chromium handles copy and paste itself); on a packaged macOS app only the app and Edit
 * menus, since there the edit shortcuts only work through menu roles.
 */
export function applicationMenuTemplate(opts: { packaged: boolean; platform: NodeJS.Platform }): MenuItemConstructorOptions[] | null | undefined {
  if (!opts.packaged) return undefined;
  return opts.platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }] : null;
}
