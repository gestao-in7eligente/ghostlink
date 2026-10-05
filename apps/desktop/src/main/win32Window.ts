// The Win32 calls behind windowTracker.ts (spec 2026-10-01-lapis-na-tela-design.md §4), through koffi
// (MIT, prebuilt N-API binaries: nothing is compiled). Windows only, and imported only when a window is
// shared with the pencil overlay; anywhere else, or if koffi fails to load, there is no overlay over
// shared windows (DrawOverlay logs it once). None of these calls sends a message to the window, so a
// hung app can never block the main process.
import type { Rectangle } from 'electron';
import type * as KoffiModule from 'koffi';
import type { WindowApi } from './windowTracker.js';

/** dwmapi.h */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const RECT_SIZE = 16;
const S_OK = 0;

/** The part of koffi this module uses. */
type Koffi = Pick<typeof KoffiModule, 'load' | 'struct' | 'out' | 'pointer'>;

interface Win32Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Win32WindowOptions {
  platform: string;
  /** import('koffi'); the tests inject it. */
  loadKoffi?: () => Promise<Koffi>;
}

/** The Win32 window calls, or null off Windows. Rejects when koffi or the DLLs fail to load. */
export async function loadWin32WindowApi(o: Win32WindowOptions): Promise<WindowApi | null> {
  if (o.platform !== 'win32') return null;
  const koffi = await (o.loadKoffi ?? (() => import('koffi')))();
  // By name, not from %SystemRoot% (an environment variable must never choose a DLL): user32 is a
  // KnownDLL, and Chromium has loaded dwmapi already; System32 comes before PATH and the working folder.
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  // HWND as a pointer-sized integer: the source id gives it as a number. BOOL is an int.
  const isWindow = user32.func('__stdcall', 'IsWindow', 'int32_t', ['intptr_t']);
  const isIconic = user32.func('__stdcall', 'IsIconic', 'int32_t', ['intptr_t']);
  const isWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int32_t', ['intptr_t']);
  const getWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int32_t', ['intptr_t', koffi.out(koffi.pointer(RECT))]);
  const dwmRect = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer(RECT)), 'uint32_t']);
  const dwmUint = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'uint32_t']);

  return {
    isWindow: (hwnd) => isWindow(hwnd) !== 0,
    isIconic: (hwnd) => isIconic(hwnd) !== 0,
    isVisible: (hwnd) => isWindowVisible(hwnd) !== 0,
    isCloaked: (hwnd) => {
      const cloaked = [0];
      return dwmUint(hwnd, DWMWA_CLOAKED, cloaked, 4) === S_OK && cloaked[0] !== 0;
    },
    frameBounds: (hwnd) => {
      // What the capture shows: the visible frame, without the invisible resize borders.
      const frame: Partial<Win32Rect> = {};
      if (dwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, frame, RECT_SIZE) === S_OK) return rectangle(frame);
      const window: Partial<Win32Rect> = {};
      return getWindowRect(hwnd, window) !== 0 ? rectangle(window) : null;
    },
  };
}

function rectangle(r: Partial<Win32Rect>): Rectangle | null {
  const { left, top, right, bottom } = r;
  if (![left, top, right, bottom].every(Number.isInteger)) return null;
  return { x: left!, y: top!, width: right! - left!, height: bottom! - top! };
}
