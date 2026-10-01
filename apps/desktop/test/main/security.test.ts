import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers: Record<string, (...args: never[]) => unknown> = {};
  return {
    handlers,
    app: { on: vi.fn((event: string, fn: (...args: never[]) => unknown) => { handlers[`app:${event}`] = fn; }) },
    session: {
      defaultSession: {
        setPermissionRequestHandler: vi.fn((fn: (...args: never[]) => unknown) => { handlers.request = fn; }),
        setPermissionCheckHandler: vi.fn((fn: (...args: never[]) => unknown) => { handlers.check = fn; }),
        on: vi.fn((event: string, fn: (...args: never[]) => unknown) => { handlers[`session:${event}`] = fn; }),
      },
    },
  };
});
vi.mock('electron', () => electron);

const { allowPermissionCheck, allowPermissionRequest, hardenWebContents, installSecurity, originOf } = await import('../../src/main/security.js');

const APP = 'app://ghostlink';

describe('originOf', () => {
  it.each([
    ['app://ghostlink/index.html#/join', 'app://ghostlink'],
    ['app://ghostlink', 'app://ghostlink'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['https://evil.example/app://ghostlink', 'https://evil.example'],
    ['app://ghostlink.evil/', 'app://ghostlink.evil'],
    ['file:///C:/app/index.html', null],
    ['data:text/html,hi', null],
    ['', null],
    ['not a url', null],
  ])('%j → %j', (url, origin) => {
    expect(originOf(url)).toBe(origin);
  });
});

describe('permission policy (spec §12)', () => {
  it('grants media requests to the app page only, whatever its path or hash', () => {
    expect(allowPermissionRequest('media', 'app://ghostlink/index.html#/voice', APP)).toBe(true);
    for (const url of ['https://evil.example/', 'app://ghostlink.evil/', 'app://evil/', 'file:///index.html', '']) {
      expect(allowPermissionRequest('media', url, APP), url).toBe(false);
    }
  });

  it('grants fullscreen (a stream's "Tela cheia") to the app page only', () => {
    expect(allowPermissionRequest('fullscreen', 'app://ghostlink/index.html', APP)).toBe(true);
    for (const url of ['https://evil.example/', 'app://ghostlink.evil/', 'file:///index.html', '']) {
      expect(allowPermissionRequest('fullscreen', url, APP), url).toBe(false);
    }
  });

  it('denies every other permission, even to the app page', () => {
    for (const p of ['notifications', 'geolocation', 'display-capture', 'clipboard-read', 'openExternal', 'pointerLock', 'unknown']) {
      expect(allowPermissionRequest(p, 'app://ghostlink/', APP), p).toBe(false);
    }
  });

  it('answers permission checks for media and speaker selection only', () => {
    expect(allowPermissionCheck('media', APP, APP)).toBe(true);
    expect(allowPermissionCheck('speaker-selection', APP, APP)).toBe(true);
    expect(allowPermissionCheck('background-sync', APP, APP)).toBe(false);
    expect(allowPermissionCheck('media', 'https://evil.example', APP)).toBe(false);
  });

  it('follows the dev server origin in development', () => {
    expect(allowPermissionRequest('media', 'http://localhost:5173/#/x', 'http://localhost:5173')).toBe(true);
    expect(allowPermissionRequest('media', 'http://localhost:5174/', 'http://localhost:5173')).toBe(false);
  });
});

describe('hardenWebContents', () => {
  it('blocks navigation and webviews, and denies every new window', () => {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    hardenWebContents(contents as never);
    for (const event of ['will-navigate', 'will-attach-webview']) {
      const e = { preventDefault: vi.fn() };
      contents.emit(event, e, 'https://evil.example/');
      expect(e.preventDefault, event).toHaveBeenCalledOnce();
    }
    const openHandler = contents.setWindowOpenHandler.mock.calls[0]![0] as (d: { url: string }) => unknown;
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });
});

describe('installSecurity', () => {
  installSecurity({ appOrigin: APP });
  const { handlers } = electron;

  it('hardens every webContents created later', () => {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    (handlers['app:web-contents-created'] as (e: unknown, c: unknown) => void)({}, contents);
    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(contents.listenerCount('will-navigate')).toBe(1);
  });

  it('wires the request handler to the policy, falling back to the page URL', () => {
    const decide = (permission: string, requestingUrl: string, pageUrl: string) => {
      let granted: boolean | undefined;
      (handlers.request as (...a: unknown[]) => void)({ getURL: () => pageUrl }, permission, (g: boolean) => { granted = g; }, { requestingUrl });
      return granted;
    };
    expect(decide('media', 'app://ghostlink/', 'app://ghostlink/')).toBe(true);
    expect(decide('media', '', 'app://ghostlink/')).toBe(true);
    expect(decide('media', 'https://evil.example/', 'app://ghostlink/')).toBe(false);
    expect(decide('notifications', 'app://ghostlink/', 'app://ghostlink/')).toBe(false);
  });

  it('wires the check handler to the policy', () => {
    const check = handlers.check as (...a: unknown[]) => boolean;
    expect(check(null, 'media', APP, {})).toBe(true);
    expect(check(null, 'geolocation', APP, {})).toBe(false);
  });

  it('lets only the app page download', () => {
    const download = handlers['session:will-download'] as (...a: unknown[]) => void;
    const fromApp = { preventDefault: vi.fn() };
    download(fromApp, {}, { getURL: () => 'app://ghostlink/' });
    expect(fromApp.preventDefault).not.toHaveBeenCalled();
    const fromElsewhere = { preventDefault: vi.fn() };
    download(fromElsewhere, {}, { getURL: () => 'https://evil.example/' });
    expect(fromElsewhere.preventDefault).toHaveBeenCalledOnce();
  });
});
