// The main window's options and the application menu, as plain data (tested without Electron).
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '@ghostlink/shared';

/**
 * The renderer runs sandboxed and isolated. DevTools exist only in development: in the
 * packaged app nobody can open a console in the page that holds the session.
 */
export function mainWindowOptions(opts: { preload: string; packaged: boolean }): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: '#0b0d10',
    title: APP_NAME,
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
