// The update splash ("Atualizar ao abrir", docs/superpowers/specs/2026-10-01-atualizar-ao-abrir-design.md):
// a small frameless window, like Discord's, shown while Updater.checkAtStartup runs and before the
// main window exists. The page is static (app://ghostlink/splash.html, built by electron-vite next to
// index.html), sandboxed and isolated; its preload only receives the view and sends "Open without updating".
import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainEvent, type NativeImage } from 'electron';
import { APP_NAME } from '@ghostlink/shared';
import type { Locale } from '../shared/ipcTypes.js';
import { SPLASH_CHANNELS, type SplashView } from '../shared/splash.js';
import { releaseEn as en } from '../renderer/i18n/release.en.js';
import { releasePtBR as ptBR } from '../renderer/i18n/release.pt-BR.js';
import type { StartupStep } from './updater.js';
import { TITLE_BAR } from './window.js';

type SplashKey = Extract<keyof typeof ptBR, `updates.splash.${string}`>;

/** The splash texts come from the renderer's updates namespace (pure data), as the tray's do. */
export function splashText(locale: Locale, key: SplashKey, vars: Readonly<Record<string, string>> = {}): string {
  const template: string = (locale === 'pt-BR' ? ptBR : en)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : match));
}

/** What the page shows for a step of the startup check, in the saved language. */
export function splashView(locale: Locale, step: StartupStep): SplashView {
  switch (step.step) {
    case 'checking':
      return { lang: locale, status: splashText(locale, 'updates.splash.checking'), percent: null, skip: null };
    case 'downloading':
      return {
        lang: locale,
        status: splashText(locale, 'updates.splash.downloading', { percent: String(step.percent) }),
        percent: step.percent,
        skip: step.canSkip ? splashText(locale, 'updates.splash.skip') : null,
      };
    case 'installing':
      return { lang: locale, status: splashText(locale, 'updates.splash.installing'), percent: 100, skip: null };
  }
}

export const SPLASH_SIZE = { width: 300, height: 300 } as const;

/** Frameless, fixed size, the window color; sandboxed like the main window, DevTools only in development. */
export function splashWindowOptions(opts: { preload: string; packaged: boolean; icon?: NativeImage }): BrowserWindowConstructorOptions {
  return {
    ...SPLASH_SIZE,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    backgroundColor: TITLE_BAR.color,
    title: APP_NAME,
    ...(opts.icon ? { icon: opts.icon } : {}),
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !opts.packaged,
      spellcheck: false,
    },
  };
}

export interface UpdateSplashOptions {
  /** app://ghostlink/splash.html */
  url: string;
  /** out/preload/splash.cjs */
  preload: string;
  packaged: boolean;
  icon?: NativeImage;
  locale: Locale;
  /** "Open without updating" was clicked. */
  onSkip(): void;
  /** The person closed the splash (Alt+F4): the app is quitting. */
  onClosedByUser?(): void;
  log?: (message: string) => void;
}

export class UpdateSplash {
  readonly #window: BrowserWindow;
  readonly #locale: Locale;
  #view: SplashView | null = null;
  #ready = false;
  #closing = false;
  #closedByUser = false;

  constructor(opts: UpdateSplashOptions) {
    this.#locale = opts.locale;
    const window = new BrowserWindow(splashWindowOptions(opts));
    this.#window = window;
    const contents = window.webContents;
    // Only this page's own preload can ask to skip; any other sender is ignored.
    const onSkip = (event: IpcMainEvent) => {
      if (event.sender === contents) opts.onSkip();
    };
    ipcMain.on(SPLASH_CHANNELS.skip, onSkip);
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
    contents.on('dom-ready', () => {
      this.#ready = true;
      this.#send();
    });
    window.on('closed', () => {
      ipcMain.removeListener(SPLASH_CHANNELS.skip, onSkip);
      if (this.#closing) return;
      this.#closedByUser = true;
      opts.onClosedByUser?.();
    });
    window.loadURL(opts.url).catch(() => (opts.log ?? console.warn)('[splash] the update splash page did not load'));
  }

  /** The person closed the splash before the app opened. */
  get closedByUser(): boolean {
    return this.#closedByUser;
  }

  show(step: StartupStep): void {
    this.#view = splashView(this.#locale, step);
    this.#send();
  }

  /** A second launch of the app brings the splash to the front. */
  focus(): void {
    if (this.#window.isDestroyed()) return;
    if (this.#window.isMinimized()) this.#window.restore();
    this.#window.focus();
  }

  close(): void {
    this.#closing = true;
    if (!this.#window.isDestroyed()) this.#window.close();
  }

  #send(): void {
    if (this.#ready && this.#view !== null && !this.#window.isDestroyed()) this.#window.webContents.send(SPLASH_CHANNELS.view, this.#view);
  }
}
