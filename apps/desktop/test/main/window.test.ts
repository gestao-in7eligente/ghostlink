import { describe, expect, it } from 'vitest';
import { applicationMenuTemplate, mainWindowOptions } from '../../src/main/window.js';

const PRELOAD = 'C:\\app\\out\\preload\\index.cjs';

describe('mainWindowOptions', () => {
  it('turns DevTools off in the packaged app and keeps them in development', () => {
    expect(mainWindowOptions({ preload: PRELOAD, platform: 'win32', packaged: true }).webPreferences?.devTools).toBe(false);
    expect(mainWindowOptions({ preload: PRELOAD, platform: 'win32', packaged: false }).webPreferences?.devTools).toBe(true);
  });

  it('uses the given icon (the ghost) instead of the executable one', () => {
    const icon = {} as Electron.NativeImage;
    expect(mainWindowOptions({ preload: PRELOAD, platform: 'win32', packaged: false, icon }).icon).toBe(icon);
    expect(mainWindowOptions({ preload: PRELOAD, platform: 'win32', packaged: true })).not.toHaveProperty('icon');
  });

  it("draws Discord's title bar on Windows and Linux, and keeps the native one on macOS", () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(mainWindowOptions({ preload: PRELOAD, platform, packaged: true })).toMatchObject({
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#2c2d32', symbolColor: '#c5c6ca', height: 32 },
      });
    }
    const mac = mainWindowOptions({ preload: PRELOAD, platform: 'darwin', packaged: true });
    expect(mac).not.toHaveProperty('titleBarStyle');
    expect(mac).not.toHaveProperty('titleBarOverlay');
  });

  it('keeps the renderer sandboxed and isolated either way', () => {
    for (const packaged of [true, false]) {
      expect(mainWindowOptions({ preload: PRELOAD, platform: 'win32', packaged }).webPreferences).toMatchObject({
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      });
    }
  });
});

describe('applicationMenuTemplate', () => {
  it('removes the menu (reload, DevTools shortcuts) in the packaged app on Windows and Linux', () => {
    expect(applicationMenuTemplate({ packaged: true, platform: 'win32' })).toBeNull();
    expect(applicationMenuTemplate({ packaged: true, platform: 'linux' })).toBeNull();
  });

  it('keeps only the app and Edit menus on a packaged macOS app, so copy and paste still work', () => {
    const template = applicationMenuTemplate({ packaged: true, platform: 'darwin' });
    expect(template).toEqual([{ role: 'appMenu' }, { role: 'editMenu' }]);
    expect(JSON.stringify(template)).not.toMatch(/toggleDevTools|reload|forceReload|viewMenu/);
  });

  it("leaves Electron's default menu alone in development", () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) expect(applicationMenuTemplate({ packaged: false, platform })).toBeUndefined();
  });
});
