// The pencil over the real shared screen (spec 2026-10-01-lapis-na-tela-design.md §4): while I share
// a whole screen, or a window on Windows, the strokes on my share also appear over it, in a
// transparent, frameless, always-on-top window that ignores the mouse and is kept out of the capture
// (setContentProtection), so they never come back in the video. Over a shared window the overlay
// follows that window (windowTracker.ts) and hides while it is minimized. The page is static
// (app://ghostlink/drawOverlay.html), sandboxed and isolated; its preload only receives strokes.
// Electron-free: index.ts injects the window factory, desktopCapturer, the displays and the Win32 calls.
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { APP_NAME } from '@ghostlink/shared';
import { DRAW_OVERLAY_CHANNELS, type OverlayStroke } from '../shared/drawOverlay.js';
import { WindowTracker, hwndOfSource, nearRect, sameRect, type WindowApi, type WindowPlacement } from './windowTracker.js';

/** The part of BrowserWindow the overlay uses. */
export interface OverlayWindow {
  setIgnoreMouseEvents(ignore: boolean): void;
  setContentProtection(enable: boolean): void;
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void;
  setBounds(bounds: Partial<Rectangle>): void;
  getBounds(): Rectangle;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  close(): void;
  loadURL(url: string): Promise<void>;
  once(event: 'closed', listener: () => void): unknown;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: 'did-finish-load', listener: () => void): unknown;
  };
}

/** desktopCapturer's screen source: its id ("screen:<n>:<n>") and the display it shows. */
export interface ScreenSourceInfo {
  id: string;
  /** screen.getAllDisplays()'s id as a string; empty where the system does not say. */
  display_id: string;
}

export interface DisplayInfo {
  id: number;
  bounds: Rectangle;
}

export interface DrawOverlayDeps {
  /** app://ghostlink/drawOverlay.html */
  url: string;
  /** out/preload/drawOverlay.cjs */
  preload: string;
  packaged: boolean;
  /** desktopCapturer's screens, without thumbnails. */
  screenSources(): Promise<ScreenSourceInfo[]>;
  displays(): DisplayInfo[];
  createWindow(options: BrowserWindowConstructorOptions): OverlayWindow;
  /** Whether this system keeps a content-protected window out of captures (keepsOutOfCapture). */
  excludedFromCapture: boolean;
  /**
   * The Win32 window calls (win32Window.ts, koffi), asked for on the first shared window: null where
   * there are none (macOS, Linux). Null or a rejection: no overlay over shared windows, logged once.
   */
  windowApi(): Promise<WindowApi | null>;
  /** screen.screenToDipRect(null, rect): a window's physical pixels → DIPs. */
  screenToDip(rect: Rectangle): Rectangle;
  log?(message: string): void;
}

/** With no new stroke for this long, every stroke has faded (renderer strokes.ts STALE_MS) and the window hides. */
export const OVERLAY_HIDE_AFTER_MS = 10_500;
/** Batches kept while the page loads. */
const QUEUE_MAX = 256;
/** Where the overlay waits, hidden, when the shared window is minimized as the share starts. */
const PARKED: Rectangle = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Windows 10 2004 (build 19041) and later remove a content-protected window from captures
 * (WDA_EXCLUDEFROMCAPTURE); older builds capture it as a black rectangle, which would cover the
 * shared screen, so there is no overlay there. macOS hides it with NSWindowSharingNone.
 */
export function keepsOutOfCapture(platform: string, release: string): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'win32') return false;
  const build = Number(release.split('.')[2]);
  return Number.isInteger(build) && build >= 19_041;
}

/** Transparent, frameless, over everything, never focused nor in the taskbar; sandboxed like the main window. */
export function overlayWindowOptions(o: { bounds: Rectangle; preload: string; packaged: boolean }): BrowserWindowConstructorOptions {
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
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    title: APP_NAME,
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !o.packaged,
      spellcheck: false,
      // Not focused and often behind nothing visible: its fades must still run on time.
      backgroundThrottling: false,
    },
  };
}

export class DrawOverlay {
  readonly #deps: DrawOverlayDeps;
  /** The source the display-media handler last handed over; null after a refusal. */
  #granted: string | null = null;
  #window: OverlayWindow | null = null;
  #ready = false;
  #queue: OverlayStroke[] = [];
  #opening: Promise<boolean> | null = null;
  /** Bumped by close(): an open() still resolving the monitor gives up. */
  #generation = 0;
  #hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Strokes are showing: from a batch until OVERLAY_HIDE_AFTER_MS after the last one. */
  #active = false;
  /** Over a shared window: where it is. Null over a whole screen. */
  #tracker: WindowTracker | null = null;
  /** The bounds last given to the window. */
  #placed: Rectangle | null = null;
  /** The Win32 calls, loaded once. */
  #windowApi: Promise<WindowApi | null> | null = null;

  constructor(deps: DrawOverlayDeps) {
    this.#deps = deps;
  }

  /** Whether the overlay window exists. */
  get isOpen(): boolean {
    return this.#window !== null && !this.#window.isDestroyed();
  }

  /** What session.setDisplayMediaRequestHandler handed over (the video source's id), or null. */
  granted(sourceId: string | null): void {
    this.#granted = sourceId;
  }

  /** Opens over the monitor or the window of the last granted source; true when it is open. */
  open(): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(true);
    this.#opening ??= this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  /** A batch to draw: shows the window and relays it to the page (queued until the page loaded). */
  stroke(stroke: OverlayStroke): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = null;
      if (this.#window === window) this.#setActive(false);
    }, OVERLAY_HIDE_AFTER_MS);
    this.#hideTimer.unref?.();
    this.#setActive(true);
    if (this.#ready) window.webContents.send(DRAW_OVERLAY_CHANNELS.stroke, stroke);
    else if (this.#queue.length < QUEUE_MAX) this.#queue.push(stroke);
  }

  /** The share ended (or the app's page went away). */
  close(): void {
    this.#generation++;
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
    this.#tracker?.stop();
    this.#tracker = null;
    this.#active = false;
    this.#placed = null;
    this.#queue = [];
    this.#ready = false;
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.close();
  }

  async #open(): Promise<boolean> {
    const generation = this.#generation;
    const sourceId = this.#granted;
    if (!this.#deps.excludedFromCapture) return false;
    if (sourceId?.startsWith('screen:')) return this.#openOverScreen(sourceId, generation);
    const hwnd = hwndOfSource(sourceId);
    return hwnd === null ? false : this.#openOverWindow(hwnd, generation);
  }

  async #openOverScreen(sourceId: string, generation: number): Promise<boolean> {
    const bounds = await this.#boundsOf(sourceId).catch(() => null);
    if (generation !== this.#generation) return false;
    if (!bounds) {
      this.#deps.log?.('[draw] the shared monitor was not found; no overlay');
      return false;
    }
    this.#create(bounds, null);
    return true;
  }

  async #openOverWindow(hwnd: number, generation: number): Promise<boolean> {
    const api = await this.#api();
    if (generation !== this.#generation || !api) return false;
    const tracker: WindowTracker = new WindowTracker({
      api,
      hwnd,
      screenToDip: (rect) => this.#deps.screenToDip(rect),
      onChange: (placement) => this.#moved(tracker, placement),
      log: this.#deps.log,
    });
    // Closed since it was chosen: nothing to follow (the capture ends too).
    const first = tracker.start();
    if (first.state === 'gone') return false;
    this.#create(first.state === 'shown' ? first.bounds : PARKED, tracker);
    return true;
  }

  /** koffi loads with the first shared window, once; without it there is no overlay over windows. */
  #api(): Promise<WindowApi | null> {
    this.#windowApi ??= Promise.resolve()
      .then(() => this.#deps.windowApi())
      .catch(() => null)
      .then((api) => {
        // No details: the reason (another system, a binary that did not load) changes nothing for the user.
        if (!api) this.#deps.log?.('[draw] no overlay over a shared window on this system');
        return api;
      });
    return this.#windowApi;
  }

  #create(bounds: Rectangle, tracker: WindowTracker | null): void {
    const window = this.#deps.createWindow(overlayWindowOptions({ bounds, preload: this.#deps.preload, packaged: this.#deps.packaged }));
    this.#window = window;
    this.#tracker = tracker;
    this.#ready = false;
    window.setIgnoreMouseEvents(true);
    // Out of the capture: the strokes must not come back in the video, doubled and late.
    window.setContentProtection(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    // Again once it exists: a monitor with another scale factor would otherwise size it wrong.
    this.#place(window, bounds);
    window.webContents.once('did-finish-load', () => {
      if (this.#window !== window) return;
      this.#ready = true;
      for (const stroke of this.#queue.splice(0)) window.webContents.send(DRAW_OVERLAY_CHANNELS.stroke, stroke);
    });
    window.once('closed', () => {
      if (this.#window === window) this.close();
    });
    window.loadURL(this.#deps.url).catch(() => this.#deps.log?.('[draw] the overlay page did not load'));
  }

  /** The shared window moved, was minimized or restored, or closed. */
  #moved(tracker: WindowTracker, placement: WindowPlacement): void {
    const window = this.#window;
    if (tracker !== this.#tracker || !window || window.isDestroyed()) return;
    if (placement.state === 'shown' && !(this.#placed && sameRect(this.#placed, placement.bounds))) this.#place(window, placement.bounds);
    this.#sync();
  }

  /**
   * setBounds, and once more when the window did not land there: moving onto a monitor with another
   * scale factor rescales it on the way.
   */
  #place(window: OverlayWindow, bounds: Rectangle): void {
    window.setBounds(bounds);
    if (!nearRect(window.getBounds(), bounds)) window.setBounds(bounds);
    this.#placed = { ...bounds };
  }

  #setActive(active: boolean): void {
    this.#active = active;
    // Turning active reads the shared window at once, so the overlay never shows where it was.
    this.#tracker?.setActive(active);
    this.#sync();
  }

  /** Shown while strokes show and what is shared is on screen (always, for a whole screen). */
  #sync(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    const onScreen = this.#tracker === null || this.#tracker.placement?.state === 'shown';
    if (this.#active && onScreen) {
      if (window.isVisible()) return;
      if (this.#placed && !nearRect(window.getBounds(), this.#placed)) window.setBounds(this.#placed);
      window.showInactive();
    } else if (window.isVisible()) {
      window.hide();
    }
  }

  async #boundsOf(sourceId: string): Promise<Rectangle | null> {
    const displays = this.#deps.displays();
    const source = (await this.#deps.screenSources()).find((s) => s.id === sourceId);
    const display = source && source.display_id !== '' ? displays.find((d) => String(d.id) === source.display_id) : undefined;
    if (display) return { ...display.bounds };
    // No display id from the system: with a single monitor, it is the one being shared.
    return displays.length === 1 ? { ...displays[0]!.bounds } : null;
  }
}
