import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';
import { TOAST_CHANNELS, type ToastUpdate } from '../../src/shared/toast.js';
import {
  TOAST_HIDE_DELAY_MS,
  TOAST_TIMEOUT_MS,
  ToastStack,
  toastBounds,
  toastWindowOptions,
  type ToastInput,
  type ToastIpcEvent,
  type ToastWindow,
} from '../../src/main/toasts.js';

type Handler = (...args: unknown[]) => void;

class Emitter {
  readonly handlers = new Map<string, Array<{ fn: Handler; once: boolean }>>();
  on(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), { fn, once: false }]);
    return this;
  }
  once(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), { fn, once: true }]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((h) => !h.once));
    for (const h of list) h.fn(...args);
  }
}

class FakeContents extends Emitter {
  readonly sent: Array<[string, unknown]> = [];
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload]);
  }
  /** The cards the page was last told about. */
  get last(): ToastUpdate {
    return this.sent.filter(([c]) => c === TOAST_CHANNELS.update).at(-1)![1] as ToastUpdate;
  }
}

class FakeWindow extends Emitter implements ToastWindow {
  readonly webContents = new FakeContents();
  bounds: Rectangle | null = null;
  visible = false;
  destroyed = false;
  url = '';
  constructor(readonly options: unknown) {
    super();
  }
  setBounds(bounds: Rectangle) {
    this.bounds = bounds;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  isVisible() {
    return this.visible;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
  getMediaSourceId() {
    return 'window:4242:0';
  }
  loadURL(url: string) {
    this.url = url;
    return Promise.resolve();
  }
}

class FakeIpc {
  readonly listeners = new Map<string, Set<(event: ToastIpcEvent, ...args: unknown[]) => void>>();
  on(channel: string, listener: (event: ToastIpcEvent, ...args: unknown[]) => void) {
    this.listeners.set(channel, new Set([...(this.listeners.get(channel) ?? []), listener]));
  }
  removeListener(channel: string, listener: (event: ToastIpcEvent, ...args: unknown[]) => void) {
    this.listeners.get(channel)?.delete(listener);
  }
  emit(channel: string, sender: unknown, ...args: unknown[]) {
    for (const listener of this.listeners.get(channel) ?? []) listener({ sender }, ...args);
  }
  get count(): number {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const HASH = 'ab'.repeat(32);

function setup() {
  const windows: FakeWindow[] = [];
  const ipc = new FakeIpc();
  const stack = new ToastStack({
    url: 'app://ghostlink/toast.html',
    preload: 'C:\\app\\out\\preload\\toast.cjs',
    packaged: true,
    platform: 'win32',
    createWindow: (options) => {
      const window = new FakeWindow(options);
      windows.push(window);
      return window;
    },
    workArea: () => WORK_AREA,
    ipc,
    locale: () => 'pt-BR',
  });
  /** The window, its page loaded. */
  const loaded = () => {
    const window = windows.at(-1)!;
    window.webContents.emit('did-finish-load');
    return window;
  };
  const page = () => windows.at(-1)!.webContents;
  return { stack, windows, ipc, loaded, page };
}

function card(title: string, extra: Partial<ToastInput> = {}): ToastInput {
  return { icon: { kind: 'initials', text: 'CA' }, title, author: 'Ana', body: 'oi', onClick: vi.fn(), ...extra };
}

const titles = (update: ToastUpdate) => update.toasts.map((t) => t.title);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('toastBounds: the bottom-right corner of the work area', () => {
  it('puts the cards 12 px from its edges, with an 8 px margin for the shadow, growing upwards', () => {
    expect(toastBounds(WORK_AREA, 1)).toEqual({ x: 1580, y: 940, width: 336, height: 96 });
    expect(toastBounds(WORK_AREA, 3)).toEqual({ x: 1580, y: 764, width: 336, height: 272 });
    // A work area that does not start at 0 (a taskbar on the left, a second display).
    const b = toastBounds({ x: 100, y: 50, width: 1000, height: 700 }, 2);
    expect(b.x + 8 + 320).toBe(100 + 1000 - 12); // the cards' right edge
    expect(b.y + b.height - 8).toBe(50 + 700 - 12); // the newest card's bottom edge
    expect(b.height).toBe(2 * 80 + 8 + 16);
  });
});

describe('toastWindowOptions', () => {
  it('is transparent and frameless, never focused nor in the taskbar, on top, and sandboxed', () => {
    const options = toastWindowOptions({ bounds: { x: 1, y: 2, width: 336, height: 96 }, preload: 'p.cjs', packaged: true, platform: 'win32' });
    expect(options).toMatchObject({
      x: 1,
      y: 2,
      width: 336,
      height: 96,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { preload: 'p.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false },
    });
  });

  it('is a tool window on Windows (never in Alt+Tab), a notification on Linux', () => {
    const options = (platform: string) => toastWindowOptions({ bounds: { x: 0, y: 0, width: 336, height: 96 }, preload: 'p.cjs', packaged: true, platform });
    expect(options('win32').type).toBe('toolbar');
    expect(options('linux').type).toBe('notification');
    expect(options('darwin')).not.toHaveProperty('type');
  });
});

describe('ToastStack', () => {
  it('opens one window with the first card and shows it without activating it once the page loaded', () => {
    const { stack, windows, loaded, page } = setup();
    expect(windows).toHaveLength(0);
    expect(stack.show(card('Casa ➜ #geral'))).toBe(true);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.url).toBe('app://ghostlink/toast.html');
    expect(windows[0]!.visible).toBe(false); // the page has not loaded yet
    loaded();
    expect(windows[0]!.visible).toBe(true);
    expect(windows[0]!.bounds).toEqual(toastBounds(WORK_AREA, 1));
    expect(page().last).toEqual({
      lang: 'pt-BR',
      closeLabel: 'Fechar',
      toasts: [{ id: 1, icon: { kind: 'initials', text: 'CA' }, title: 'Casa ➜ #geral', author: 'Ana', body: 'oi' }],
    });
    stack.show(card('Casa ➜ #random'));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.bounds).toEqual(toastBounds(WORK_AREA, 2));
    expect(titles(page().last)).toEqual(['Casa ➜ #geral', 'Casa ➜ #random']); // the newest at the bottom
  });

  it('keeps three cards at most: a fourth sends the oldest away', () => {
    const { stack, loaded, page } = setup();
    stack.show(card('1'));
    loaded();
    for (const title of ['2', '3', '4']) stack.show(card(title));
    expect(stack.size).toBe(3);
    expect(titles(page().last)).toEqual(['2', '3', '4']);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS);
    expect(stack.size).toBe(0); // the oldest one's timer went with it
  });

  it('each card leaves after 5 s; an empty stack hides the window a moment later', () => {
    const { stack, windows, loaded, page } = setup();
    stack.show(card('1'));
    loaded();
    vi.advanceTimersByTime(2_000);
    stack.show(card('2'));
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 2_000);
    expect(titles(page().last)).toEqual(['2']);
    expect(windows[0]!.bounds).toEqual(toastBounds(WORK_AREA, 1));
    vi.advanceTimersByTime(2_000);
    expect(page().last.toasts).toEqual([]);
    expect(windows[0]!.visible).toBe(true); // its empty frame first
    vi.advanceTimersByTime(TOAST_HIDE_DELAY_MS);
    expect(windows[0]!.visible).toBe(false);
    expect(windows[0]!.destroyed).toBe(false); // kept for the next card
    stack.show(card('3'));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.visible).toBe(true);
  });

  it('none leaves while the mouse is over the cards; they count their 5 s again once it is out', () => {
    const { stack, loaded, ipc, page } = setup();
    stack.show(card('1'));
    const window = loaded();
    ipc.emit(TOAST_CHANNELS.hover, window.webContents, true);
    stack.show(card('2'));
    vi.advanceTimersByTime(60_000);
    expect(titles(page().last)).toEqual(['1', '2']);
    ipc.emit(TOAST_CHANNELS.hover, window.webContents, false);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
    expect(stack.size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(stack.size).toBe(0);
  });

  it('a click reaches whoever asked for the card and closes it; × only closes it', () => {
    const { stack, loaded, ipc } = setup();
    const first = card('1');
    const second = card('2');
    stack.show(first);
    stack.show(second);
    const window = loaded();
    ipc.emit(TOAST_CHANNELS.click, window.webContents, 1);
    expect(first.onClick).toHaveBeenCalledOnce();
    expect(second.onClick).not.toHaveBeenCalled();
    expect(window.webContents.last.toasts.map((t) => t.id)).toEqual([2]);
    ipc.emit(TOAST_CHANNELS.click, window.webContents, 1); // already gone
    ipc.emit(TOAST_CHANNELS.close, window.webContents, 2);
    expect(first.onClick).toHaveBeenCalledOnce();
    expect(second.onClick).not.toHaveBeenCalled();
    expect(stack.size).toBe(0);
  });

  it("ignores clicks, closes and the mouse from anything but the cards' own page, and odd values", () => {
    const { stack, loaded, ipc } = setup();
    const first = card('1');
    stack.show(first);
    const window = loaded();
    const other = { id: 'the main window' };
    ipc.emit(TOAST_CHANNELS.click, other, 1);
    ipc.emit(TOAST_CHANNELS.close, other, 1);
    ipc.emit(TOAST_CHANNELS.hover, other, true);
    ipc.emit(TOAST_CHANNELS.click, window.webContents, '1');
    ipc.emit(TOAST_CHANNELS.hover, window.webContents, 'yes');
    expect(first.onClick).not.toHaveBeenCalled();
    expect(stack.size).toBe(1);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS); // the hover from elsewhere paused nothing
    expect(stack.size).toBe(0);
  });

  it('cleans and bounds every text, and loads no picture but the ones main serves', () => {
    const { stack, loaded, page } = setup();
    expect(stack.show(card('\u200B\n'))).toBe(false); // nothing to say
    stack.show(card(`Casa\u202E ➜\n#geral${'x'.repeat(100)}`, { author: `Ana\u0000${'y'.repeat(50)}`, body: `linha 1\nlinha 2${'z'.repeat(500)}` }));
    stack.show(card('a', { icon: { kind: 'image', url: `app://ghostlink/_avatar/${HASH}`, fallback: 'Casa' } }));
    stack.show(card('b', { icon: { kind: 'image', url: 'https://evil.example/x.png', fallback: 'EM' } }));
    loaded();
    const [first, second, third] = page().last.toasts;
    expect(first!.title.startsWith('Casa ➜ #geral')).toBe(true);
    expect(first!.title).toHaveLength(64);
    expect(first!.author!.startsWith('Ana y')).toBe(true);
    expect(first!.author).toHaveLength(32);
    expect(first!.body.startsWith('linha 1 linha 2')).toBe(true);
    expect(first!.body).toHaveLength(200);
    expect(second!.icon).toEqual({ kind: 'image', url: `app://ghostlink/_avatar/${HASH}`, fallback: 'Ca' });
    expect(third!.icon).toEqual({ kind: 'initials', text: 'EM' });
  });

  it('a crashed page takes its cards along; the next card opens a new window', () => {
    const { stack, windows, loaded } = setup();
    stack.show(card('1'));
    loaded().webContents.emit('render-process-gone');
    expect(windows[0]!.destroyed).toBe(true);
    expect(stack.size).toBe(0);
    stack.show(card('2'));
    expect(windows).toHaveLength(2);
  });

  it('when the app quits, the window goes and no card shows any more', () => {
    const { stack, windows, ipc, loaded } = setup();
    expect(ipc.count).toBe(3);
    stack.show(card('1'));
    loaded();
    stack.dispose();
    stack.dispose();
    expect(windows[0]!.destroyed).toBe(true);
    expect(ipc.count).toBe(0);
    expect(stack.show(card('2'))).toBe(false);
    expect(windows).toHaveLength(1);
  });
});
