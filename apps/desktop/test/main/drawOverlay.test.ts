// The pencil over the real shared screen (spec 2026-10-01-lapis-na-tela-design.md §4): the window's
// options, the monitor or the shared window it covers, click-through and out of the capture, and its
// lifetime. Over a window, a fake of the Win32 calls stands for the window; draw.e2e.ts shares a real
// one. The real window on a real monitor is on the manual checklist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { DRAW_OVERLAY_CHANNELS, type OverlayStroke } from '../../src/shared/drawOverlay.js';
import { DrawOverlay, OVERLAY_HIDE_AFTER_MS, keepsOutOfCapture, overlayWindowOptions, type DrawOverlayDeps, type OverlayWindow } from '../../src/main/drawOverlay.js';
import { TRACK_ACTIVE_MS, TRACK_IDLE_MS, type WindowApi } from '../../src/main/windowTracker.js';

const PRELOAD = 'C:\\app\\out\\preload\\drawOverlay.cjs';
const URL = 'app://ghostlink/drawOverlay.html';
const LEFT: Rectangle = { x: -1920, y: 0, width: 1920, height: 1080 };
const MAIN: Rectangle = { x: 0, y: 0, width: 2560, height: 1440 };
/** The shared window ("window:133240:0") and where Win32 says it is, in physical pixels. */
const HWND = 133240;
const SHARED = 'window:133240:0';

/** A 200 % monitor: screen.screenToDipRect(null, rect) halves everything. */
const halfScale = (r: Rectangle): Rectangle => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 });

/** The shared window as Win32 reports it; `reads` counts the polls. */
class FakeApi implements WindowApi {
  exists = true;
  iconic = false;
  cloaked = false;
  bounds: Rectangle = { x: 200, y: 100, width: 1600, height: 1000 };
  reads = 0;
  isWindow(hwnd: number) {
    return hwnd === HWND && this.exists;
  }
  isIconic() {
    return this.iconic;
  }
  isVisible() {
    return true;
  }
  isCloaked() {
    return this.cloaked;
  }
  frameBounds() {
    this.reads++;
    return { ...this.bounds };
  }
}

class FakeWindow implements OverlayWindow {
  calls: string[] = [];
  sent: [string, unknown][] = [];
  visible = false;
  destroyed = false;
  url = '';
  bounds: Partial<Rectangle> = {};
  #closed: (() => void)[] = [];
  #loaded: (() => void)[] = [];
  constructor(readonly options: BrowserWindowConstructorOptions) {}
  setIgnoreMouseEvents(ignore: boolean) {
    this.calls.push(`ignoreMouse:${ignore}`);
  }
  setContentProtection(enable: boolean) {
    this.calls.push(`contentProtection:${enable}`);
  }
  setAlwaysOnTop(flag: boolean, level?: string) {
    this.calls.push(`alwaysOnTop:${flag}:${level}`);
  }
  /** Every setBounds, in order. */
  placed: Partial<Rectangle>[] = [];
  /** Set to rescale the next setBounds, as Windows does when a window lands on a monitor with another scale. */
  rescaleOnce: number | null = null;
  setBounds(bounds: Partial<Rectangle>) {
    this.placed.push(bounds);
    const k = this.rescaleOnce;
    this.rescaleOnce = null;
    this.bounds = k === null ? bounds : { ...bounds, width: (bounds.width ?? 0) * k, height: (bounds.height ?? 0) * k };
  }
  getBounds(): Rectangle {
    return { x: 0, y: 0, width: 0, height: 0, ...this.bounds };
  }
  /** Where it was when last shown. */
  shownAt: Partial<Rectangle> | null = null;
  showInactive() {
    this.visible = true;
    this.shownAt = { ...this.bounds };
    this.calls.push('showInactive');
  }
  hide() {
    this.visible = false;
    this.calls.push('hide');
  }
  isVisible() {
    return this.visible;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
    for (const fn of this.#closed.splice(0)) fn();
  }
  loadURL(url: string) {
    this.url = url;
    return Promise.resolve();
  }
  once(_event: 'closed', listener: () => void) {
    this.#closed.push(listener);
  }
  webContents = {
    send: (channel: string, ...args: unknown[]) => void this.sent.push([channel, args[0]]),
    once: (_event: 'did-finish-load', listener: () => void) => void this.#loaded.push(listener),
  };
  /** The page finished loading. */
  load() {
    for (const fn of this.#loaded.splice(0)) fn();
  }
}

function setup(o: Partial<DrawOverlayDeps> = {}, api: FakeApi = new FakeApi()) {
  const windows: FakeWindow[] = [];
  const logs: string[] = [];
  const overlay = new DrawOverlay({
    url: URL,
    preload: PRELOAD,
    packaged: true,
    screenSources: async () => [
      { id: 'screen:0:0', display_id: '2528732444' },
      { id: 'screen:1:0', display_id: '2779098405' },
    ],
    displays: () => [
      { id: 2779098405, bounds: LEFT },
      { id: 2528732444, bounds: MAIN },
    ],
    createWindow: (options) => {
      const w = new FakeWindow(options);
      windows.push(w);
      return w;
    },
    excludedFromCapture: true,
    windowApi: async () => api,
    screenToDip: halfScale,
    log: (m) => logs.push(m),
    ...o,
  });
  return { overlay, windows, logs, api };
}

const STROKE: OverlayStroke = { id: `${'b'.repeat(32)}:s1`, color: '#ff6b6b', label: 'Bia', points: [[0.5, 0.5]], end: false };

describe('overlayWindowOptions', () => {
  it('is transparent, frameless, on top, never focused nor in the taskbar, and sandboxed', () => {
    const options = overlayWindowOptions({ bounds: MAIN, preload: PRELOAD, packaged: true });
    expect(options).toMatchObject({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
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
    });
    expect(options.webPreferences).toEqual({
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
      backgroundThrottling: false,
    });
    expect(overlayWindowOptions({ bounds: LEFT, preload: PRELOAD, packaged: false }).webPreferences?.devTools).toBe(true);
  });
});

describe('keepsOutOfCapture', () => {
  it('needs Windows 10 2004 or later (WDA_EXCLUDEFROMCAPTURE); older builds would capture a black window', () => {
    expect(keepsOutOfCapture('win32', '10.0.26200')).toBe(true);
    expect(keepsOutOfCapture('win32', '10.0.19041')).toBe(true);
    expect(keepsOutOfCapture('win32', '10.0.18363')).toBe(false);
    expect(keepsOutOfCapture('win32', '6.1.7601')).toBe(false);
    expect(keepsOutOfCapture('win32', 'garbage')).toBe(false);
    expect(keepsOutOfCapture('darwin', '24.0.0')).toBe(true);
    expect(keepsOutOfCapture('linux', '6.8.0')).toBe(false);
  });
});

describe('DrawOverlay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens over the monitor of the shared screen: click-through, out of the capture, on top', async () => {
    const { overlay, windows } = setup();
    overlay.granted('screen:1:0');
    expect(await overlay.open()).toBe(true);
    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(w.options).toMatchObject({ ...LEFT, transparent: true, focusable: false });
    expect(w.bounds).toEqual(LEFT);
    expect(w.calls).toEqual(['ignoreMouse:true', 'contentProtection:true', 'alwaysOnTop:true:screen-saver']);
    expect(w.url).toBe(URL);
    // Hidden until the first stroke.
    expect(w.visible).toBe(false);
    expect(overlay.isOpen).toBe(true);
  });

  it('opens once, however often it is asked', async () => {
    const { overlay, windows } = setup();
    overlay.granted('screen:0:0');
    const [a, b] = await Promise.all([overlay.open(), overlay.open()]);
    expect([a, b, await overlay.open()]).toEqual([true, true, true]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.options).toMatchObject(MAIN);
  });

  it('is only for screens and windows: not with nothing granted, a refused capture or a malformed id', async () => {
    for (const granted of ['window:0:0', 'window:abc:0', 'tab:1:0', null]) {
      const { overlay, windows } = setup();
      overlay.granted(granted);
      expect(await overlay.open()).toBe(false);
      expect(windows).toEqual([]);
    }
  });

  it('is never opened where the system would capture it as a black rectangle', async () => {
    for (const granted of ['screen:0:0', SHARED]) {
      const { overlay, windows } = setup({ excludedFromCapture: false });
      overlay.granted(granted);
      expect(await overlay.open()).toBe(false);
      expect(windows).toEqual([]);
    }
  });

  it('finds no monitor: no overlay (with one monitor and no display id, that one)', async () => {
    const unknown = setup({ screenSources: async () => [{ id: 'screen:0:0', display_id: '' }] });
    unknown.overlay.granted('screen:0:0');
    expect(await unknown.overlay.open()).toBe(false);
    expect(unknown.logs).toEqual(['[draw] the shared monitor was not found; no overlay']);
    const single = setup({ screenSources: async () => [{ id: 'screen:0:0', display_id: '' }], displays: () => [{ id: 1, bounds: MAIN }] });
    single.overlay.granted('screen:0:0');
    expect(await single.overlay.open()).toBe(true);
    expect(single.windows[0]!.bounds).toEqual(MAIN);
    const failing = setup({ screenSources: () => Promise.reject(new Error('capturer')) });
    failing.overlay.granted('screen:0:0');
    expect(await failing.overlay.open()).toBe(false);
  });

  it('relays strokes once the page loaded, showing the window without focusing it, and hides it when all faded', async () => {
    const { overlay, windows } = setup();
    overlay.granted('screen:0:0');
    await overlay.open();
    const w = windows[0]!;
    overlay.stroke(STROKE);
    expect(w.visible).toBe(true);
    expect(w.calls).toContain('showInactive');
    expect(w.sent).toEqual([]); // queued until the page loaded
    w.load();
    const next = { ...STROKE, points: [[0.6, 0.6]] as [number, number][], end: true };
    overlay.stroke(next);
    expect(w.sent).toEqual([
      [DRAW_OVERLAY_CHANNELS.stroke, STROKE],
      [DRAW_OVERLAY_CHANNELS.stroke, next],
    ]);
    vi.advanceTimersByTime(OVERLAY_HIDE_AFTER_MS - 1);
    expect(w.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(w.visible).toBe(false);
    overlay.stroke(STROKE);
    expect(w.visible).toBe(true);
  });

  it('closes when the share ends, drops strokes after that, and can open again for the next share', async () => {
    const { overlay, windows } = setup();
    overlay.granted('screen:0:0');
    await overlay.open();
    overlay.close();
    expect(windows[0]!.destroyed).toBe(true);
    expect(overlay.isOpen).toBe(false);
    overlay.stroke(STROKE);
    expect(windows[0]!.sent).toEqual([]);
    overlay.close(); // twice is fine
    overlay.granted('screen:1:0');
    expect(await overlay.open()).toBe(true);
    expect(windows).toHaveLength(2);
    expect(windows[1]!.bounds).toEqual(LEFT);
  });

  it('gives up an opening when the share ends while the monitor is looked up', async () => {
    let answer!: (s: { id: string; display_id: string }[]) => void;
    const { overlay, windows } = setup({ screenSources: () => new Promise((r) => (answer = r)) });
    overlay.granted('screen:0:0');
    const opening = overlay.open();
    overlay.close();
    answer([{ id: 'screen:0:0', display_id: '2528732444' }]);
    expect(await opening).toBe(false);
    expect(windows).toEqual([]);
  });

  it('forgets a window closed from outside', async () => {
    const { overlay, windows } = setup();
    overlay.granted('screen:0:0');
    await overlay.open();
    windows[0]!.close();
    expect(overlay.isOpen).toBe(false);
    expect(await overlay.open()).toBe(true);
    expect(windows).toHaveLength(2);
  });
});

describe('DrawOverlay over a shared window (Windows)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** FakeApi's window in DIPs (halfScale). */
  const DIP: Rectangle = { x: 100, y: 50, width: 800, height: 500 };

  async function sharing(o: Partial<DrawOverlayDeps> = {}, api: FakeApi = new FakeApi()) {
    const s = setup(o, api);
    s.overlay.granted(SHARED);
    expect(await s.overlay.open()).toBe(true);
    return { ...s, w: s.windows[0]! };
  }

  it('opens over the window, in DIPs: click-through, out of the capture, on top, hidden until a stroke', async () => {
    const { overlay, w } = await sharing();
    expect(w.options).toMatchObject({ ...DIP, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true });
    expect(w.bounds).toEqual(DIP);
    expect(w.calls).toEqual(['ignoreMouse:true', 'contentProtection:true', 'alwaysOnTop:true:screen-saver']);
    expect(w.url).toBe(URL);
    expect(w.visible).toBe(false);
    expect(overlay.isOpen).toBe(true);
  });

  it('follows the window: within half a second while idle, every ~33 ms while strokes show', async () => {
    const { overlay, w, api } = await sharing();
    api.bounds = { x: 400, y: 300, width: 1600, height: 1000 };
    vi.advanceTimersByTime(TRACK_IDLE_MS);
    expect(w.bounds).toEqual({ x: 200, y: 150, width: 800, height: 500 });
    overlay.stroke(STROKE);
    expect(w.visible).toBe(true);
    api.bounds = { x: 500, y: 300, width: 1200, height: 1000 }; // dragged and resized while someone draws
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.bounds).toEqual({ x: 250, y: 150, width: 600, height: 500 });
    // Every stroke faded: hidden, and back to the slow pace.
    vi.advanceTimersByTime(OVERLAY_HIDE_AFTER_MS);
    expect(w.visible).toBe(false);
    const reads = api.reads;
    vi.advanceTimersByTime(1000);
    expect(api.reads - reads).toBe(2);
  });

  it('reads the window as the first stroke arrives, so it never shows where the window was', async () => {
    const { overlay, w, api } = await sharing();
    vi.advanceTimersByTime(100); // between two slow polls
    api.bounds = { x: 0, y: 0, width: 1000, height: 800 };
    overlay.stroke(STROKE);
    expect(w.visible).toBe(true);
    expect(w.shownAt).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });

  it('hides while the window is minimized or on another virtual desktop, and comes back over it', async () => {
    const { overlay, w, api } = await sharing();
    overlay.stroke(STROKE);
    api.iconic = true;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.visible).toBe(false);
    overlay.stroke(STROKE); // still drawing: stays hidden
    expect(w.visible).toBe(false);
    api.iconic = false;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.visible).toBe(true);
    api.cloaked = true;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.visible).toBe(false);
    api.cloaked = false;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.visible).toBe(true);
  });

  it('a window minimized as the share starts: parked and hidden, then over the window once restored', async () => {
    const api = new FakeApi();
    api.iconic = true;
    const { overlay, w } = await sharing({}, api);
    expect(w.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    overlay.stroke(STROKE);
    expect(w.visible).toBe(false);
    api.iconic = false;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.bounds).toEqual(DIP);
    expect(w.visible).toBe(true);
    expect(w.shownAt).toEqual(DIP);
  });

  it('the window closes: the overlay hides and stops reading it', async () => {
    const { overlay, w, api } = await sharing();
    overlay.stroke(STROKE);
    api.exists = false;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(w.visible).toBe(false);
    const reads = api.reads;
    overlay.stroke(STROKE);
    vi.advanceTimersByTime(5_000);
    expect(w.visible).toBe(false);
    expect(api.reads).toBe(reads);
  });

  it('a window closed before the overlay opens: no overlay, nothing polled', async () => {
    const api = new FakeApi();
    api.exists = false;
    const { overlay, windows } = setup({}, api);
    overlay.granted(SHARED);
    expect(await overlay.open()).toBe(false);
    expect(windows).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the share ends: the overlay closes and the window is no longer read', async () => {
    const { overlay, w, api } = await sharing();
    overlay.stroke(STROKE);
    overlay.close();
    expect(w.destroyed).toBe(true);
    const reads = api.reads;
    vi.advanceTimersByTime(5_000);
    expect(api.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('places it again when a monitor with another scale factor resized it on the way', async () => {
    const { overlay, w, api } = await sharing();
    overlay.stroke(STROKE);
    w.placed = [];
    w.rescaleOnce = 1.5;
    api.bounds = { x: 4000, y: 0, width: 1600, height: 1000 };
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    const target = { x: 2000, y: 0, width: 800, height: 500 };
    expect(w.placed).toEqual([target, target]);
    expect(w.bounds).toEqual(target);
  });

  it('without the Win32 calls (macOS, Linux, koffi not loaded): no overlay over windows, logged once without details', async () => {
    const failures = [async () => null, () => Promise.reject(new Error('Cannot find the native Koffi module at C:\Users\someone'))];
    for (const windowApi of failures) {
      const { overlay, windows, logs } = setup({ windowApi });
      overlay.granted(SHARED);
      expect(await overlay.open()).toBe(false);
      overlay.granted('window:200:0');
      expect(await overlay.open()).toBe(false);
      expect(windows).toEqual([]);
      expect(logs).toEqual(['[draw] no overlay over a shared window on this system']);
      // Whole screens are not affected.
      overlay.granted('screen:0:0');
      expect(await overlay.open()).toBe(true);
    }
  });

  it('loads the Win32 calls once, with the first shared window', async () => {
    const windowApi = vi.fn(async (): Promise<WindowApi | null> => new FakeApi());
    const { overlay } = setup({ windowApi });
    overlay.granted('screen:0:0');
    await overlay.open();
    expect(windowApi).not.toHaveBeenCalled();
    overlay.close();
    overlay.granted(SHARED);
    expect(await overlay.open()).toBe(true);
    overlay.close();
    expect(await overlay.open()).toBe(true);
    expect(windowApi).toHaveBeenCalledTimes(1);
  });

  it('gives up an opening when the share ends while the Win32 calls load', async () => {
    let answer!: (api: WindowApi | null) => void;
    const { overlay, windows } = setup({ windowApi: () => new Promise((r) => (answer = r)) });
    overlay.granted(SHARED);
    const opening = overlay.open();
    overlay.close();
    await Promise.resolve();
    answer(new FakeApi());
    expect(await opening).toBe(false);
    expect(windows).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
