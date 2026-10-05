import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CALL_WINDOW_NAME } from '../../src/shared/callWindow.js';
import { CallWindow, callWindowBounds, callWindowOptions, type CallOpener, type CallPopup } from '../../src/main/callWindow.js';
import { ScreenPicker } from '../../src/main/screenPicker.js';
import { hardenWebContents } from '../../src/main/security.js';

const APP = 'app://ghostlink';
const PAGE = 'app://ghostlink/index.html#/servers';
/** The primary display's work area: 1920×1080 with a 40 px taskbar at the bottom. */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const POPUP_ID = 'window:5243012:1';
const BLANK = { url: 'about:blank', frameName: CALL_WINDOW_NAME };

function popup(): CallPopup & EventEmitter & { destroyed: boolean } {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    setContentProtection: vi.fn(),
    showInactive: vi.fn(),
    close: vi.fn(() => {
      window.destroyed = true;
      window.emit('closed');
    }),
    isDestroyed: () => window.destroyed,
    getMediaSourceId: () => POPUP_ID,
  });
  return window;
}

function setup(platform = 'win32') {
  const call = new CallWindow({ appOrigin: APP, packaged: true, platform, workArea: () => WORK_AREA });
  const opener = Object.assign(new EventEmitter(), { id: 1, getURL: () => PAGE });
  call.attach(opener as unknown as CallOpener);
  /** What the main window's page gets for a window.open (security.ts' handler around the rule). */
  const open = (details: { url: string; frameName: string }, from: { id: number; getURL(): string } = opener) => call.rule(from, details) ?? { action: 'deny' };
  /** Electron created the popup the rule allowed. */
  const create = (frameName = CALL_WINDOW_NAME) => {
    const window = popup();
    opener.emit('did-create-window', window, { frameName });
    return window;
  };
  return { call, opener, open, create };
}

describe('the mini window: where and how it opens', () => {
  it('sits 12 px from the bottom-right corner of the work area, 320×380', () => {
    expect(callWindowBounds(WORK_AREA)).toEqual({ x: 1588, y: 648, width: 320, height: 380 });
    expect(callWindowBounds({ x: -1280, y: 200, width: 1280, height: 984 })).toEqual({ x: -332, y: 792, width: 320, height: 380 });
  });

  it('is frameless, always on top, fixed, hidden until shown, out of the taskbar and Alt+Tab, and sandboxed without a preload', () => {
    const options = callWindowOptions({ bounds: callWindowBounds(WORK_AREA), packaged: true, platform: 'win32' });
    expect(options).toMatchObject({
      x: 1588,
      y: 648,
      width: 320,
      height: 380,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: 'toolbar',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false },
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
    expect(callWindowOptions({ bounds: callWindowBounds(WORK_AREA), packaged: false, platform: 'linux' })).not.toHaveProperty('type');
  });
});

describe('the window.open rule (only the mini window, from the app page)', () => {
  it("allows the mini window from the main window's page, with its options, closing with its opener", () => {
    const { open } = setup();
    expect(open(BLANK)).toEqual({
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: callWindowOptions({ bounds: callWindowBounds(WORK_AREA), packaged: true, platform: 'win32' }),
    });
    expect(open({ url: '', frameName: CALL_WINDOW_NAME }).action).toBe('allow');
  });

  it('denies any other name, any real page, another origin and any other webContents', () => {
    const { open, opener } = setup();
    expect(open({ url: 'about:blank', frameName: '' })).toEqual({ action: 'deny' });
    expect(open({ url: 'about:blank', frameName: '_blank' })).toEqual({ action: 'deny' });
    expect(open({ url: 'https://evil.example/', frameName: CALL_WINDOW_NAME })).toEqual({ action: 'deny' });
    expect(open({ url: 'app://ghostlink/index.html', frameName: CALL_WINDOW_NAME })).toEqual({ action: 'deny' });
    expect(open(BLANK, { id: 1, getURL: () => 'https://evil.example/' })).toEqual({ action: 'deny' });
    expect(open(BLANK, { id: 2, getURL: () => PAGE })).toEqual({ action: 'deny' });
    // The popup's own page (about:blank) can open nothing.
    expect(open(BLANK, { id: 3, getURL: () => 'about:blank' })).toEqual({ action: 'deny' });
    expect(opener.id).toBe(1);
  });

  it('denies everything before the main window is attached', () => {
    const call = new CallWindow({ appOrigin: APP, packaged: true, platform: 'win32', workArea: () => WORK_AREA });
    expect(call.rule({ id: 1, getURL: () => PAGE }, BLANK)).toBeNull();
  });

  it('allows one at a time: another one only after it closed', () => {
    const { open, create, call } = setup();
    const window = create();
    expect(open(BLANK)).toEqual({ action: 'deny' });
    call.close();
    expect(window.close).toHaveBeenCalledOnce();
    expect(open(BLANK).action).toBe('allow');
  });

  it('goes through hardenWebContents: the main page gets the mini window, every other window.open stays denied', () => {
    const { call } = setup();
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => PAGE, setWindowOpenHandler: vi.fn() });
    hardenWebContents(contents as never, call.rule);
    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (d: { url: string; frameName: string }) => { action: string };
    expect(handler(BLANK).action).toBe('allow');
    expect(handler({ url: 'https://example.com/', frameName: '' })).toEqual({ action: 'deny' });
  });
});

describe('the mini window once created', () => {
  it('is kept out of captures and shown without taking the focus', () => {
    const { create } = setup();
    const window = create();
    expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it('is left out of the share picker while open', async () => {
    const { call, create } = setup();
    expect(call.mediaSourceId()).toBeNull();
    const window = create();
    expect(call.mediaSourceId()).toBe(POPUP_ID);
    const image = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,eA' };
    const picker = new ScreenPicker({
      getSources: async () => [
        { id: 'screen:0:0', name: 'Tela', thumbnail: image, appIcon: null },
        { id: POPUP_ID, name: 'GhostLink', thumbnail: image, appIcon: image },
      ],
      now: () => 0,
      appOrigin: APP,
      ownMediaSourceIds: () => [call.mediaSourceId()].filter((id) => id !== null),
    });
    expect((await picker.listSources()).map((s) => s.id)).toEqual(['screen:0:0']);
    window.close();
    expect(call.mediaSourceId()).toBeNull();
  });

  it('closes when the page reloads or crashes', () => {
    for (const event of ['did-start-loading', 'render-process-gone']) {
      const { opener, create, call } = setup();
      const window = create();
      opener.emit(event);
      expect(window.close, event).toHaveBeenCalledOnce();
      expect(call.mediaSourceId()).toBeNull();
    }
  });

  it('ignores any other window (the rule never allows one)', () => {
    const { create, call } = setup();
    const other = create('something-else');
    expect(other.setContentProtection).not.toHaveBeenCalled();
    expect(call.mediaSourceId()).toBeNull();
  });
});
