import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLASH_CHANNELS } from '../../src/shared/splash.js';

const electron = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Array<{ fn: (...args: unknown[]) => void; once: boolean }>>();
    on(event: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), { fn, once: false }]);
      return this;
    }
    once(event: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), { fn, once: true }]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      const list = this.handlers.get(event) ?? [];
      this.handlers.set(event, list.filter((h) => !h.once));
      for (const h of list) h.fn(...args);
    }
  }
  class WebContents extends Emitter {
    sent: Array<[string, unknown]> = [];
    send(channel: string, payload: unknown) {
      this.sent.push([channel, payload]);
    }
  }
  const windows: BrowserWindow[] = [];
  class BrowserWindow extends Emitter {
    webContents = new WebContents();
    url = '';
    shown = false;
    focused = false;
    destroyed = false;
    constructor(readonly options: unknown) {
      super();
      windows.push(this);
    }
    loadURL(url: string) {
      this.url = url;
      return Promise.resolve();
    }
    show() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const ipcMain = new Emitter();
  return {
    windows,
    BrowserWindow,
    ipcMain: Object.assign(ipcMain, {
      removeListener(event: string, fn: (...args: unknown[]) => void) {
        ipcMain.handlers.set(event, (ipcMain.handlers.get(event) ?? []).filter((h) => h.fn !== fn));
      },
      count: (event: string) => (ipcMain.handlers.get(event) ?? []).length,
    }),
  };
});
vi.mock('electron', () => electron);

const { SPLASH_SIZE, UpdateSplash, splashText, splashView, splashWindowOptions } = await import('../../src/main/updateSplash.js');

const PRELOAD = 'C:\\app\\out\\preload\\splash.cjs';
const SPLASH_URL = 'app://ghostlink/splash.html';

beforeEach(() => {
  electron.windows.length = 0;
  electron.ipcMain.handlers.clear();
});

describe('splash texts (pt-BR and en, from the saved locale)', () => {
  it('speaks both languages', () => {
    expect(splashText('pt-BR', 'updates.splash.checking')).toBe('Procurando atualizações…');
    expect(splashText('en', 'updates.splash.checking')).toBe('Checking for updates…');
    expect(splashText('pt-BR', 'updates.splash.downloading', { percent: '42' })).toBe('Baixando atualização… 42%');
    expect(splashText('en', 'updates.splash.downloading', { percent: '42' })).toBe('Downloading update… 42%');
    expect(splashText('pt-BR', 'updates.splash.installing')).toBe('Instalando…');
    expect(splashText('en', 'updates.splash.installing')).toBe('Installing…');
    expect(splashText('pt-BR', 'updates.splash.skip')).toBe('Abrir sem atualizar');
    expect(splashText('en', 'updates.splash.skip')).toBe('Open without updating');
  });

  it('turns each step of the startup check into what the page shows', () => {
    expect(splashView('pt-BR', { step: 'checking' })).toEqual({ lang: 'pt-BR', status: 'Procurando atualizações…', percent: null, skip: null });
    expect(splashView('pt-BR', { step: 'downloading', percent: 42, canSkip: false })).toEqual({
      lang: 'pt-BR',
      status: 'Baixando atualização… 42%',
      percent: 42,
      skip: null,
    });
    expect(splashView('en', { step: 'downloading', percent: 7, canSkip: true })).toEqual({
      lang: 'en',
      status: 'Downloading update… 7%',
      percent: 7,
      skip: 'Open without updating',
    });
    expect(splashView('en', { step: 'installing' })).toEqual({ lang: 'en', status: 'Installing…', percent: 100, skip: null });
  });
});

describe('splashWindowOptions', () => {
  it('is a small frameless window of the app color, hidden until painted', () => {
    expect(SPLASH_SIZE).toEqual({ width: 300, height: 340 });
    expect(splashWindowOptions({ preload: PRELOAD, packaged: true })).toMatchObject({
      width: 300,
      height: 340,
      frame: false,
      resizable: false,
      show: false,
      backgroundColor: '#2c2d32',
      title: 'GhostLink',
    });
  });

  it('is sandboxed and isolated, without Node, and DevTools only in development', () => {
    for (const packaged of [true, false]) {
      expect(splashWindowOptions({ preload: PRELOAD, packaged }).webPreferences).toMatchObject({
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: !packaged,
      });
    }
  });
});

describe('UpdateSplash', () => {
  function open(extra: { onSkip?: () => void; onClosedByUser?: () => void } = {}) {
    const onSkip = vi.fn(extra.onSkip);
    const onClosedByUser = vi.fn(extra.onClosedByUser);
    const splash = new UpdateSplash({ url: SPLASH_URL, preload: PRELOAD, packaged: true, locale: 'pt-BR', onSkip, onClosedByUser, log: () => {} });
    return { splash, window: electron.windows.at(-1)!, onSkip, onClosedByUser };
  }

  it('loads the static page and shows the window once painted', () => {
    const { window } = open();
    expect(window.url).toBe(SPLASH_URL);
    expect(window.shown).toBe(false);
    window.emit('ready-to-show');
    expect(window.shown).toBe(true);
  });

  it('sends the latest view once the page is ready, then every change', () => {
    const { splash, window } = open();
    splash.show({ step: 'checking' });
    splash.show({ step: 'downloading', percent: 3, canSkip: false });
    expect(window.webContents.sent).toEqual([]);
    window.webContents.emit('dom-ready');
    expect(window.webContents.sent).toEqual([[SPLASH_CHANNELS.view, expect.objectContaining({ status: 'Baixando atualização… 3%' })]]);
    splash.show({ step: 'installing' });
    expect(window.webContents.sent.at(-1)).toEqual([SPLASH_CHANNELS.view, expect.objectContaining({ status: 'Instalando…' })]);
  });

  it('accepts "Open without updating" only from its own page', () => {
    const { window, onSkip } = open();
    electron.ipcMain.emit(SPLASH_CHANNELS.skip, { sender: {} as unknown });
    expect(onSkip).not.toHaveBeenCalled();
    electron.ipcMain.emit(SPLASH_CHANNELS.skip, { sender: window.webContents });
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('tells a close by the person apart from its own, and stops listening either way', () => {
    const own = open();
    own.splash.close();
    expect(own.splash.closedByUser).toBe(false);
    expect(own.onClosedByUser).not.toHaveBeenCalled();
    expect(electron.ipcMain.count(SPLASH_CHANNELS.skip)).toBe(0);
    own.splash.show({ step: 'checking' }); // nothing to send to: no throw
    own.splash.close();

    const byUser = open();
    byUser.window.close(); // Alt+F4
    expect(byUser.splash.closedByUser).toBe(true);
    expect(byUser.onClosedByUser).toHaveBeenCalledTimes(1);
    expect(electron.ipcMain.count(SPLASH_CHANNELS.skip)).toBe(0);
  });

  it('comes to the front on a second launch', () => {
    const { splash, window } = open();
    splash.focus();
    expect(window.focused).toBe(true);
  });
});
