// The Win32 window calls through koffi (spec 2026-10-01-lapis-na-tela-design.md §4): nothing off
// Windows, a failed koffi load rejects (DrawOverlay then has no overlay over shared windows), and on
// Windows the real calls answer for a handle that is no window. A real window is in draw.e2e.ts.
import { describe, expect, it } from 'vitest';
import { loadWin32WindowApi } from '../../src/main/win32Window.js';
import { placementOf } from '../../src/main/windowTracker.js';

describe('loadWin32WindowApi', () => {
  it('is null off Windows, without loading koffi', async () => {
    for (const platform of ['darwin', 'linux']) {
      let loaded = false;
      const api = await loadWin32WindowApi({
        platform,
        loadKoffi: () => {
          loaded = true;
          return Promise.reject(new Error('never'));
        },
      });
      expect(api, platform).toBeNull();
      expect(loaded).toBe(false);
    }
  });

  it('rejects when koffi fails to load', async () => {
    await expect(loadWin32WindowApi({ platform: 'win32', loadKoffi: () => Promise.reject(new Error('no binary')) })).rejects.toThrow('no binary');
  });

  it.runIf(process.platform === 'win32')('calls the real Win32 API: a handle that is no window is gone', async () => {
    const api = (await loadWin32WindowApi({ platform: 'win32' }))!;
    expect(api).not.toBeNull();
    // Window handles are multiples of 2 on Windows: 1 is never one.
    expect(api.isWindow(1)).toBe(false);
    expect(api.isIconic(1)).toBe(false);
    expect(api.isVisible(1)).toBe(false);
    expect(api.isCloaked(1)).toBe(false);
    expect(api.frameBounds(1)).toBeNull();
    expect(placementOf(api, 1)).toEqual({ state: 'gone' });
  });
});
