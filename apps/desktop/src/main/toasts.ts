// GhostLink's own notification cards (spec 2026-10-02-notificacoes-design.md), like Telegram's and
// Discord's desktop popups: up to three 320×80 cards in the bottom-right corner of the primary
// display's work area (above the taskbar), the newest at the bottom pushing the others up. Each one
// goes after 5 s, none while the mouse is over them; a click opens GhostLink on what the card is
// about, × closes it. No sound. One window holds them all: transparent, frameless, never focused nor
// in the taskbar, shown without being activated, sized to the stack and hidden once it is empty.
// The page is static (app://ghostlink/toast.html), sandboxed and isolated; its preload only receives
// the cards and sends clicks, closes and the mouse over them, and only that page's messages count.
// Electron-free: index.ts injects the window factory, the work area and ipcMain.
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { APP_NAME } from '@ghostlink/shared';
import type { Locale } from '../shared/ipcTypes.js';
import { TOAST_CHANNELS, type ToastIcon, type ToastUpdate, type ToastView } from '../shared/toast.js';
import { notificationText, notificationsText } from './notifications.js';
import type { Timers } from './railway/serverUpdates.js';

export const TOAST_SIZE = { width: 320, height: 80 } as const;
/** Between two cards. */
export const TOAST_GAP = 8;
/** Transparent room around the stack, where the cards' shadow falls. */
export const TOAST_MARGIN = 8;
/** From the work area's right and bottom edges to the cards. */
export const TOAST_EDGE = 12;
/** Cards on screen at once: a fourth one sends the oldest away. */
export const TOAST_MAX = 3;
export const TOAST_TIMEOUT_MS = 5_000;
/** One line each, at most this long (the page cuts them further with an ellipsis). */
export const TOAST_TEXT_MAX = { title: 64, author: 32, body: 200 } as const;
/** An emptied window hides this much later, so the frame it shows again next time is an empty one. */
export const TOAST_HIDE_DELAY_MS = 250;
/** The only pictures a card loads: photos and server icons, which main serves itself (avatarRoute.ts). */
const IMAGE_URL = /^app:\/\/ghostlink\/_avatar\/[0-9a-f]{64}$/;

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The window for `count` cards: the stack plus its margin, the cards 12 px from the work area's bottom-right corner. */
export function toastBounds(workArea: Rectangle, count: number): Rectangle {
  const cards = Math.max(1, count);
  const width = TOAST_SIZE.width + 2 * TOAST_MARGIN;
  const height = cards * TOAST_SIZE.height + (cards - 1) * TOAST_GAP + 2 * TOAST_MARGIN;
  return {
    x: workArea.x + workArea.width - TOAST_EDGE - TOAST_SIZE.width - TOAST_MARGIN,
    y: workArea.y + workArea.height - TOAST_EDGE - height + TOAST_MARGIN,
    width,
    height,
  };
}

/**
 * The window's kind for the system: on Windows a tool window (WS_EX_TOOLWINDOW), never in Alt+Tab
 * nor in the taskbar; on Linux a notification for the window manager.
 */
export function toastWindowType(platform: string): string | undefined {
  if (platform === 'win32') return 'toolbar';
  return platform === 'linux' ? 'notification' : undefined;
}

/** Transparent, frameless, over the other windows, never focused nor in the taskbar; sandboxed like the main window. */
export function toastWindowOptions(o: { bounds: Rectangle; preload: string; packaged: boolean; platform: string }): BrowserWindowConstructorOptions {
  const type = toastWindowType(o.platform);
  return {
    x: o.bounds.x,
    y: o.bounds.y,
    width: o.bounds.width,
    height: o.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    // The normal "always on top" level: over the other apps' windows, never over the screen saver.
    alwaysOnTop: true,
    title: APP_NAME,
    ...(type === undefined ? {} : { type }),
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !o.packaged,
      spellcheck: false,
      // Never focused, often shown again after a while hidden: its first frame must not wait.
      backgroundThrottling: false,
    },
  };
}

/** Initials as a card shows them: up to two characters of plain text, '?' when nothing is left. */
function initials(raw: string): string {
  return [...raw.replace(/\p{Cc}|\p{Cf}|\s/gu, '')].slice(0, 2).join('') || '?';
}

/** A card's picture: an app:// photo (anything else becomes its initials), two initials, or the ghost. */
export function cleanIcon(icon: ToastIcon): ToastIcon {
  switch (icon.kind) {
    case 'image':
      return IMAGE_URL.test(icon.url) ? { kind: 'image', url: icon.url, fallback: initials(icon.fallback) } : { kind: 'initials', text: initials(icon.fallback) };
    case 'initials':
      return { kind: 'initials', text: initials(icon.text) };
    case 'ghost':
      return { kind: 'ghost' };
  }
}

/** The part of BrowserWindow the cards use. */
export interface ToastWindow {
  setBounds(bounds: Rectangle): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  getMediaSourceId(): string;
  loadURL(url: string): Promise<void>;
  once(event: 'closed', listener: () => void): unknown;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: 'did-finish-load', listener: () => void): unknown;
    on(event: 'render-process-gone', listener: () => void): unknown;
  };
}

/** What ipcMain hands a listener: who sent the message. */
export interface ToastIpcEvent {
  sender: unknown;
}

type ToastListener = (event: ToastIpcEvent, ...args: unknown[]) => void;

/** The part of ipcMain the cards use. */
export interface ToastIpc {
  on(channel: string, listener: ToastListener): unknown;
  removeListener(channel: string, listener: ToastListener): unknown;
}

export interface ToastStackDeps {
  /** app://ghostlink/toast.html */
  url: string;
  /** out/preload/toast.cjs */
  preload: string;
  packaged: boolean;
  /** process.platform (the window's kind, toastWindowType). */
  platform: string;
  createWindow(options: BrowserWindowConstructorOptions): ToastWindow;
  /** screen.getPrimaryDisplay().workArea: the primary screen without the taskbar, in DIPs. */
  workArea(): Rectangle;
  ipc: ToastIpc;
  /** The saved language (the page's lang and the × button's name). */
  locale(): Locale;
  timers?: Timers;
  log?(message: string): void;
}

/** A card to show; its texts are cleaned and bounded here, whoever made them. */
export interface ToastInput {
  icon: ToastIcon;
  title: string;
  author: string | null;
  body: string;
  /** The card was clicked (it is gone by then). */
  onClick(): void;
}

interface Entry {
  view: ToastView;
  onClick(): void;
  /** Its 5 s, or null while the mouse is over the cards. */
  timer: unknown;
}

export class ToastStack {
  readonly #deps: ToastStackDeps;
  readonly #timers: Timers;
  readonly #listeners: ReadonlyArray<readonly [string, ToastListener]>;
  /** Oldest first: the order of the cards from the top. */
  #entries: Entry[] = [];
  #nextId = 1;
  #window: ToastWindow | null = null;
  /** The page loaded: it can take the cards. */
  #ready = false;
  #hovered = false;
  #hideTimer: unknown = null;
  #disposed = false;

  constructor(deps: ToastStackDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? REAL_TIMERS;
    // Only the cards' own page may click, close or pause them; any other sender is ignored.
    const fromPage =
      (handle: (arg: unknown) => void): ToastListener =>
      (event, arg) => {
        if (this.#fromPage(event)) handle(arg);
      };
    this.#listeners = [
      [TOAST_CHANNELS.click, fromPage((id) => this.#clicked(id))],
      [TOAST_CHANNELS.close, fromPage((id) => this.#closed(id))],
      [TOAST_CHANNELS.hover, fromPage((on) => this.#hover(on))],
    ];
    for (const [channel, listener] of this.#listeners) deps.ipc.on(channel, listener);
  }

  /** The cards on screen. */
  get size(): number {
    return this.#entries.length;
  }

  /** Shows a card at the bottom of the stack; false when it says nothing (no title once cleaned) or the app is quitting. */
  show(input: ToastInput): boolean {
    if (this.#disposed) return false;
    const title = notificationText(input.title, TOAST_TEXT_MAX.title);
    if (title === '') return false;
    const author = input.author === null ? null : notificationText(input.author, TOAST_TEXT_MAX.author) || null;
    const view: ToastView = { id: this.#nextId++, icon: cleanIcon(input.icon), title, author, body: notificationText(input.body, TOAST_TEXT_MAX.body) };
    const entry: Entry = { view, onClick: input.onClick, timer: null };
    this.#entries.push(entry);
    while (this.#entries.length > TOAST_MAX) this.#stop(this.#entries.shift()!);
    if (!this.#hovered) this.#count(entry);
    this.#render();
    return true;
  }

  /** The cards' window as desktopCapturer names it, so the screen-share picker leaves it out; null without one. */
  mediaSourceId(): string | null {
    const window = this.#window;
    return window === null || window.isDestroyed() ? null : window.getMediaSourceId();
  }

  /** The app is quitting (or its window closed): no more cards, the window goes. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [channel, listener] of this.#listeners) this.#deps.ipc.removeListener(channel, listener);
    const window = this.#window;
    this.#forget();
    if (window && !window.isDestroyed()) window.destroy();
  }

  #fromPage(event: ToastIpcEvent): boolean {
    const window = this.#window;
    return window !== null && !window.isDestroyed() && event.sender === window.webContents;
  }

  #find(id: unknown): Entry | undefined {
    return typeof id === 'number' ? this.#entries.find((e) => e.view.id === id) : undefined;
  }

  #clicked(id: unknown): void {
    const entry = this.#find(id);
    if (!entry) return; // gone meanwhile
    this.#remove(entry);
    try {
      entry.onClick();
    } catch (e) {
      this.#deps.log?.(`[toasts] a card's click failed: ${String(e)}`);
    }
  }

  #closed(id: unknown): void {
    const entry = this.#find(id);
    if (entry) this.#remove(entry);
  }

  /** Over the cards none of them leaves; they all count their 5 s again once the mouse is out. */
  #hover(on: unknown): void {
    if (typeof on !== 'boolean' || on === this.#hovered) return;
    this.#hovered = on;
    for (const entry of this.#entries) {
      this.#stop(entry);
      if (!on) this.#count(entry);
    }
  }

  #count(entry: Entry): void {
    entry.timer = this.#timers.setTimeout(() => {
      entry.timer = null;
      this.#remove(entry);
    }, TOAST_TIMEOUT_MS);
  }

  #stop(entry: Entry): void {
    if (entry.timer !== null) this.#timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  #remove(entry: Entry): void {
    const index = this.#entries.indexOf(entry);
    if (index < 0) return;
    this.#stop(entry);
    this.#entries.splice(index, 1);
    this.#render();
  }

  /** The page first (so a shrinking stack never shows a cut card), then the window's size, then the window. */
  #render(): void {
    if (this.#entries.length === 0) {
      this.#hovered = false;
      this.#send();
      this.#hideLater();
      return;
    }
    this.#cancelHide();
    const window = this.#open();
    if (!this.#ready) return; // the page's load shows them
    this.#send();
    window.setBounds(toastBounds(this.#deps.workArea(), this.#entries.length));
    if (!window.isVisible()) window.showInactive();
  }

  #send(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || !this.#ready) return;
    const lang = this.#deps.locale();
    const update: ToastUpdate = { lang, closeLabel: notificationsText(lang, 'notifications.close'), toasts: this.#entries.map((e) => e.view) };
    window.webContents.send(TOAST_CHANNELS.update, update);
  }

  /** The window, created with the first card and kept, hidden, between them. */
  #open(): ToastWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const bounds = toastBounds(this.#deps.workArea(), this.#entries.length);
    const { preload, packaged, platform } = this.#deps;
    const window = this.#deps.createWindow(toastWindowOptions({ bounds, preload, packaged, platform }));
    this.#window = window;
    this.#ready = false;
    window.webContents.once('did-finish-load', () => {
      if (this.#window !== window) return;
      this.#ready = true;
      this.#render();
    });
    // A crashed page takes its cards with it; the next card opens a new window.
    window.webContents.on('render-process-gone', () => {
      if (this.#window !== window) return;
      this.#forget();
      if (!window.isDestroyed()) window.destroy();
    });
    window.once('closed', () => {
      if (this.#window === window) this.#forget();
    });
    window.loadURL(this.#deps.url).catch(() => this.#deps.log?.('[toasts] the notification page did not load'));
    return window;
  }

  #hideLater(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || !window.isVisible() || this.#hideTimer !== null) return;
    this.#hideTimer = this.#timers.setTimeout(() => {
      this.#hideTimer = null;
      if (this.#entries.length === 0 && this.#window === window && !window.isDestroyed()) window.hide();
    }, TOAST_HIDE_DELAY_MS);
  }

  #cancelHide(): void {
    if (this.#hideTimer !== null) this.#timers.clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  /** Drops the window and every card (it closed, crashed, or the app is quitting). */
  #forget(): void {
    for (const entry of this.#entries) this.#stop(entry);
    this.#entries = [];
    this.#cancelHide();
    this.#window = null;
    this.#ready = false;
    this.#hovered = false;
  }
}
