import { describe, expect, it } from 'vitest';
import { applicationMenuTemplate, mainWindowOptions } from '../../src/main/window.js';

const PRELOAD = 'C:\\app\\out\\preload\\index.cjs';

describe('mainWindowOptions', () => {
  it('turns DevTools off in the packaged app and keeps them in development', () => {
    expect(mainWindowOptions({ preload: PRELOAD, packaged: true }).webPreferences?.devTools).toBe(false);
    expect(mainWindowOptions({ preload: PRELOAD, packaged: false }).webPreferences?.devTools).toBe(true);
  });

  it('keeps the renderer sandboxed and isolated either way', () => {
    for (const packaged of [true, false]) {
      expect(mainWindowOptions({ preload: PRELOAD, packaged }).webPreferences).toMatchObject({
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
