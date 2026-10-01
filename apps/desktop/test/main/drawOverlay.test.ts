// The pencil over the real shared screen (spec 2026-10-01-lapis-na-tela-design.md §4): the window's
// options, the monitor it covers, click-through and out of the capture, whole screens only, and
// its lifetime. The real window on a real monitor is on the manual checklist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { DRAW_OVERLAY_CHANNELS, type OverlayStroke } from '../../src/shared/drawOverlay.js';
import { DrawOverlay, OVERLAY_HIDE_AFTER_MS, keepsOutOfCapture, overlayWindowOptions, type DrawOverlayDeps, type OverlayWindow } from '../../src/main/drawOverlay.js';

const PRELOAD = 'C:\\app\\out\\preload\\drawOverlay.cjs';
const URL = 'app://ghostlink/drawOverlay.html';
const LEFT: Rectangle = { x: -1920, y: 0, width: 1920, height: 1080 };
const MAIN: Rectangle = { x: 0, y: 0, width: 2560, height: 1440 };

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
  setBounds(bounds: Partial<Rectangle>) {
    this.bounds = bounds;
  }
  showInactive() {
    this.visible = true;
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

function setup(o: Partial<DrawOverlayDeps> = {}) {
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
    log: (m) => logs.push(m),
    ...o,
  });
  return { overlay, windows, logs };
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

  it('is only for whole screens: not for a window, nothing granted, or a refused capture', async () => {
    for (const granted of ['window:133240:0', null]) {
      const { overlay, windows } = setup();
      overlay.granted(granted);
      expect(await overlay.open()).toBe(false);
      expect(windows).toEqual([]);
    }
  });

  it('is never opened where the system would capture it as a black rectangle', async () => {
    const { overlay, windows } = setup({ excludedFromCapture: false });
    overlay.granted('screen:0:0');
    expect(await overlay.open()).toBe(false);
    expect(windows).toEqual([]);
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
