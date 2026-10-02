// The call's mini window while I share my screen (spec 2026-10-02-janelinha-da-chamada-design.md),
// like Google Meet's picture-in-picture while presenting. The main window's page opens it
// (window.open('', CALL_WINDOW_NAME)) and React draws the call into it, so it shows the call's own
// state and video tracks: no second connection. Main lets exactly that popup through (security.ts'
// WindowOpenRule) with its options: frameless, always on top, out of the taskbar and Alt+Tab, 12 px
// from the bottom-right corner of the primary display's work area. Once created it is kept out of
// screen captures (setContentProtection) and out of the share picker (mediaSourceId); its own
// webContents is hardened like every other one (no navigation, no window.open). It closes with the
// page: a reload, a crash, or the main window closing (outlivesOpener: false).
// Electron-free: index.ts injects the work area and attaches the main window's webContents.
import type { BrowserWindowConstructorOptions, Rectangle, WindowOpenHandlerResponse } from 'electron';
import { APP_NAME } from '@ghostlink/shared';
import { CALL_WINDOW_NAME, CALL_WINDOW_SIZE } from '../shared/callWindow.js';
import { originOf, type WindowOpenDetails, type WindowOpenRule } from './security.js';

/** From the work area's right and bottom edges. */
export const CALL_WINDOW_EDGE = 12;

/** The window before the page draws: --bg-0 (tokens.css), so it never flashes white. */
const BACKGROUND = '#2c2d32';

/** 320×380, 12 px from the work area's bottom-right corner (above the taskbar). */
export function callWindowBounds(workArea: Rectangle): Rectangle {
  return {
    x: workArea.x + workArea.width - CALL_WINDOW_EDGE - CALL_WINDOW_SIZE.width,
    y: workArea.y + workArea.height - CALL_WINDOW_EDGE - CALL_WINDOW_SIZE.height,
    width: CALL_WINDOW_SIZE.width,
    height: CALL_WINDOW_SIZE.height,
  };
}

/**
 * Frameless (the page's top bar drags it), always on top, a fixed size, never in the taskbar;
 * on Windows a tool window (WS_EX_TOOLWINDOW), so not in Alt+Tab either. Hidden until main shows
 * it without taking the focus. Sandboxed and isolated like the main window, without a preload:
 * the page that opened it draws everything.
 */
export function callWindowOptions(o: { bounds: Rectangle; packaged: boolean; platform: string }): BrowserWindowConstructorOptions {
  return {
    x: o.bounds.x,
    y: o.bounds.y,
    width: o.bounds.width,
    height: o.bounds.height,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: BACKGROUND,
    title: APP_NAME,
    ...(o.platform === 'win32' ? { type: 'toolbar' } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !o.packaged,
      spellcheck: false,
    },
  };
}

/** The mini window's request: its name and a blank page (window.open('') reports about:blank), from the app's own page. */
export function isCallWindowRequest(details: WindowOpenDetails, openerUrl: string, appOrigin: string): boolean {
  return details.frameName === CALL_WINDOW_NAME && (details.url === 'about:blank' || details.url === '') && originOf(openerUrl) === appOrigin;
}

/** The part of BrowserWindow the mini window uses. */
export interface CallPopup {
  setContentProtection(enable: boolean): void;
  showInactive(): void;
  close(): void;
  isDestroyed(): boolean;
  getMediaSourceId(): string;
  once(event: 'closed', listener: () => void): unknown;
}

/** The main window's webContents, as the mini window follows it. */
export interface CallOpener {
  readonly id: number;
  on(event: 'did-create-window', listener: (window: CallPopup, details: { frameName: string }) => void): unknown;
  on(event: 'did-start-loading', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
}

export interface CallWindowDeps {
  /** app://ghostlink, or the dev server origin in development. */
  appOrigin: string;
  packaged: boolean;
  /** process.platform (the window's kind). */
  platform: string;
  /** screen.getPrimaryDisplay().workArea: the primary screen without the taskbar, in DIPs. */
  workArea(): Rectangle;
}

export class CallWindow {
  readonly #deps: CallWindowDeps;
  /** The main window's webContents: the only opener allowed. */
  #openerId: number | null = null;
  #window: CallPopup | null = null;

  constructor(deps: CallWindowDeps) {
    this.#deps = deps;
  }

  /**
   * For installSecurity: the mini window from the main window's page, one at a time; null (denied)
   * for anything else, from any page.
   */
  readonly rule: WindowOpenRule = (opener, details): WindowOpenHandlerResponse | null => {
    if (this.#openerId === null || opener.id !== this.#openerId) return null;
    if (!isCallWindowRequest(details, opener.getURL(), this.#deps.appOrigin) || this.#open() !== null) return null;
    const bounds = callWindowBounds(this.#deps.workArea());
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: callWindowOptions({ bounds, packaged: this.#deps.packaged, platform: this.#deps.platform }),
    };
  };

  /** The main window's webContents: the mini window opens from it and closes when its page goes. */
  attach(opener: CallOpener): void {
    this.#openerId = opener.id;
    opener.on('did-create-window', (window, details) => this.#created(window, details.frameName));
    // A reload or a crash ends the call and the share; the main window closing takes it too.
    opener.on('did-start-loading', () => this.close());
    opener.on('render-process-gone', () => this.close());
  }

  /** The mini window as desktopCapturer names it, so the share picker leaves it out; null without one. */
  mediaSourceId(): string | null {
    return this.#open()?.getMediaSourceId() ?? null;
  }

  close(): void {
    const window = this.#open();
    this.#window = null;
    window?.close();
  }

  #open(): CallPopup | null {
    return this.#window !== null && !this.#window.isDestroyed() ? this.#window : null;
  }

  #created(window: CallPopup, frameName: string): void {
    if (frameName !== CALL_WINDOW_NAME) return; // the rule lets nothing else through
    this.#window = window;
    window.once('closed', () => {
      if (this.#window === window) this.#window = null;
    });
    // Out of what the others watch: Windows 10 2004+ leaves it out of every capture.
    window.setContentProtection(true);
    // Never takes the focus from what I am presenting.
    window.showInactive();
  }
}
