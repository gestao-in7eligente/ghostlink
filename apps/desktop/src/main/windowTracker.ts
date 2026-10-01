// Where a shared window is on screen, for the pencil overlay (spec 2026-10-01-lapis-na-tela-design.md §4).
// A window share's source id carries the window's handle ("window:<HWND>:<n>"); the tracker reads that
// window's place through the Win32 calls (win32Window.ts, koffi) and reports each change in DIPs, so
// the overlay can sit exactly over it. Electron- and koffi-free: the calls and the DIP conversion are
// injected, and the tests fake them.
import type { Rectangle } from 'electron';

/** The Win32 calls the tracker uses; win32Window.ts implements them with koffi. */
export interface WindowApi {
  /** IsWindow: false once the window was destroyed. */
  isWindow(hwnd: number): boolean;
  /** IsIconic: minimized. */
  isIconic(hwnd: number): boolean;
  /** IsWindowVisible. */
  isVisible(hwnd: number): boolean;
  /** DWMWA_CLOAKED: on another virtual desktop (IsWindowVisible still says true there). */
  isCloaked(hwnd: number): boolean;
  /**
   * In physical pixels: DWMWA_EXTENDED_FRAME_BOUNDS (what the window capture shows, without the
   * invisible resize borders), else GetWindowRect; null when both fail.
   */
  frameBounds(hwnd: number): Rectangle | null;
}

/** Where the shared window is: closed for good, not on screen now, or shown over `bounds`. */
export type WindowPlacement = { state: 'gone' } | { state: 'hidden' } | { state: 'shown'; bounds: Rectangle };

/** Polling while the overlay shows strokes: about 30 Hz, so it keeps up with a dragged window. */
export const TRACK_ACTIVE_MS = 33;
/** Polling otherwise: about 2 Hz, so the overlay is already in place when a stroke arrives. */
export const TRACK_IDLE_MS = 500;

/** The window handle of a window share's source id ("window:<HWND>:<n>"), or null for anything else. */
export function hwndOfSource(sourceId: string | null): number | null {
  const match = /^window:(\d{1,20}):\d+$/.exec(sourceId ?? '');
  if (!match) return null;
  const hwnd = Number(match[1]);
  return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null;
}

/** The window's placement in physical pixels: minimized, hidden, cloaked or empty hide the overlay. */
export function placementOf(api: WindowApi, hwnd: number): WindowPlacement {
  if (!api.isWindow(hwnd)) return { state: 'gone' };
  if (api.isIconic(hwnd) || !api.isVisible(hwnd) || api.isCloaked(hwnd)) return { state: 'hidden' };
  const bounds = api.frameBounds(hwnd);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { state: 'hidden' };
  return { state: 'shown', bounds };
}

/**
 * Physical pixels → DIPs, which BrowserWindow.setBounds takes. `screenToDip` is Electron's
 * screen.screenToDipRect(null, rect): it scales by the monitor nearest to the rect, so a window on a
 * 150 % monitor next to a 100 % one converts with its own monitor's factor.
 */
export function dipPlacement(placement: WindowPlacement, screenToDip: (rect: Rectangle) => Rectangle): WindowPlacement {
  if (placement.state !== 'shown') return placement;
  const r = screenToDip(placement.bounds);
  return { state: 'shown', bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
}

export function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether a rectangle is within `tolerance` DIPs of another on every edge (DPI rounding). */
export function nearRect(a: Rectangle, b: Rectangle, tolerance = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

export function samePlacement(a: WindowPlacement | null, b: WindowPlacement): boolean {
  if (!a || a.state !== b.state) return false;
  return a.state !== 'shown' || b.state !== 'shown' || sameRect(a.bounds, b.bounds);
}

/** How long until the next look at the window. */
export function trackInterval(active: boolean): number {
  return active ? TRACK_ACTIVE_MS : TRACK_IDLE_MS;
}

export interface WindowTrackerDeps {
  api: WindowApi;
  hwnd: number;
  /** screen.screenToDipRect(null, rect). */
  screenToDip(rect: Rectangle): Rectangle;
  /** Every change after start(), in DIPs. 'gone' is the last one: the tracker stops by itself. */
  onChange(placement: WindowPlacement): void;
  log?(message: string): void;
}

/** Follows one window: start() reads it now, then it polls fast while active, slowly otherwise. */
export class WindowTracker {
  readonly #deps: WindowTrackerDeps;
  #placement: WindowPlacement | null = null;
  #active = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: WindowTrackerDeps) {
    this.#deps = deps;
  }

  /** The last placement read (DIPs); null before start(). */
  get placement(): WindowPlacement | null {
    return this.#placement;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Reads the window now and starts polling; the answer is returned, not reported to onChange. */
  start(): WindowPlacement {
    const placement = this.#read();
    this.#placement = placement;
    if (placement.state === 'gone') this.stop();
    else this.#schedule();
    return placement;
  }

  /** Active while the overlay shows strokes: turning it on reads the window at once (it may have moved). */
  setActive(active: boolean): void {
    if (this.#stopped || active === this.#active) return;
    this.#active = active;
    if (active) this.#poll();
    else this.#schedule();
  }

  /** The share ended, or the window is gone. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#poll();
    }, trackInterval(this.#active));
    this.#timer.unref?.();
  }

  #poll(): void {
    if (this.#stopped) return;
    const placement = this.#read();
    const changed = !samePlacement(this.#placement, placement);
    this.#placement = placement;
    if (placement.state === 'gone') this.stop();
    else this.#schedule();
    if (changed) this.#deps.onChange(placement);
  }

  #read(): WindowPlacement {
    try {
      return dipPlacement(placementOf(this.#deps.api, this.#deps.hwnd), (rect) => this.#deps.screenToDip(rect));
    } catch {
      // The calls never throw for a bad handle; if they throw anyway, stop following the window.
      this.#deps.log?.('[draw] the shared window could not be read; no overlay over it');
      return { state: 'gone' };
    }
  }
}
