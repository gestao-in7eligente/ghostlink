// Following a shared window for the pencil overlay (spec 2026-10-01-lapis-na-tela-design.md §4): the
// handle in the source id, physical → DIP, when the overlay hides, and the polling cadence, over a
// fake of the Win32 calls. The real calls are in win32Window.test.ts; a real window in draw.e2e.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';
import {
  TRACK_ACTIVE_MS,
  TRACK_IDLE_MS,
  WindowTracker,
  dipPlacement,
  hwndOfSource,
  nearRect,
  placementOf,
  samePlacement,
  trackInterval,
  type WindowApi,
  type WindowPlacement,
} from '../../src/main/windowTracker.js';

const HWND = 133240;

/** One window's state, as Win32 would report it; `reads` counts the frame reads (the polls). */
class FakeApi implements WindowApi {
  exists = true;
  iconic = false;
  visible = true;
  cloaked = false;
  bounds: Rectangle | null = { x: 100, y: 50, width: 1200, height: 800 };
  reads = 0;
  isWindow(hwnd: number) {
    return hwnd === HWND && this.exists;
  }
  isIconic() {
    return this.iconic;
  }
  isVisible() {
    return this.visible;
  }
  isCloaked() {
    return this.cloaked;
  }
  frameBounds() {
    this.reads++;
    return this.bounds && { ...this.bounds };
  }
}

/** A 150 % monitor at the right of a 100 % one, like screen.screenToDipRect(null, rect) on Windows. */
function mixedDpi(rect: Rectangle): Rectangle {
  if (rect.x < 1920) return { ...rect };
  return { x: 1920 + (rect.x - 1920) / 1.5, y: rect.y / 1.5, width: rect.width / 1.5, height: rect.height / 1.5 };
}

describe('hwndOfSource', () => {
  it("reads the window handle of a window share's id", () => {
    expect(hwndOfSource('window:133240:0')).toBe(133240);
    expect(hwndOfSource('window:67284:1')).toBe(67284);
  });

  it('is null for screens, malformed ids, a zero or oversized handle, and nothing', () => {
    for (const id of ['screen:0:0', 'window:abc:0', 'window:133240', 'window::0', ' window:1:0', 'window:1:0 ', 'window:0:0', 'window:99999999999999999999:0', '', null]) {
      expect(hwndOfSource(id), String(id)).toBeNull();
    }
  });
});

describe('placementOf', () => {
  it('is shown over the frame bounds when the window is on screen', () => {
    expect(placementOf(new FakeApi(), HWND)).toEqual({ state: 'shown', bounds: { x: 100, y: 50, width: 1200, height: 800 } });
  });

  it('is gone once the window was destroyed', () => {
    const api = new FakeApi();
    api.exists = false;
    expect(placementOf(api, HWND)).toEqual({ state: 'gone' });
  });

  it('is hidden when minimized, invisible, cloaked (another virtual desktop), empty or unreadable', () => {
    const cases: [string, (api: FakeApi) => void][] = [
      ['minimized', (api) => (api.iconic = true)],
      ['invisible', (api) => (api.visible = false)],
      ['cloaked', (api) => (api.cloaked = true)],
      ['empty', (api) => (api.bounds = { x: 0, y: 0, width: 0, height: 600 })],
      ['unreadable', (api) => (api.bounds = null)],
    ];
    for (const [name, change] of cases) {
      const api = new FakeApi();
      change(api);
      expect(placementOf(api, HWND), name).toEqual({ state: 'hidden' });
    }
  });
});

describe('dipPlacement', () => {
  it('converts physical pixels to DIPs with the monitor the window is on, rounded', () => {
    const on100 = { state: 'shown', bounds: { x: 100, y: 50, width: 1200, height: 800 } } as const;
    expect(dipPlacement(on100, mixedDpi)).toEqual(on100);
    const on150 = { state: 'shown', bounds: { x: 1920 + 300, y: 150, width: 1500, height: 901 } } as const;
    expect(dipPlacement(on150, mixedDpi)).toEqual({ state: 'shown', bounds: { x: 2120, y: 100, width: 1000, height: 601 } });
  });

  it('leaves hidden and gone alone, without converting', () => {
    const screenToDip = vi.fn(mixedDpi);
    expect(dipPlacement({ state: 'hidden' }, screenToDip)).toEqual({ state: 'hidden' });
    expect(dipPlacement({ state: 'gone' }, screenToDip)).toEqual({ state: 'gone' });
    expect(screenToDip).not.toHaveBeenCalled();
  });
});

describe('comparisons', () => {
  it('compares placements by state and bounds', () => {
    const at = (x: number): WindowPlacement => ({ state: 'shown', bounds: { x, y: 0, width: 10, height: 10 } });
    expect(samePlacement(null, at(0))).toBe(false);
    expect(samePlacement(at(0), at(0))).toBe(true);
    expect(samePlacement(at(0), at(1))).toBe(false);
    expect(samePlacement({ state: 'hidden' }, { state: 'hidden' })).toBe(true);
    expect(samePlacement({ state: 'hidden' }, { state: 'gone' })).toBe(false);
  });

  it('tolerates the DPI rounding of a window placed on another monitor', () => {
    const r = { x: 10, y: 10, width: 100, height: 100 };
    expect(nearRect(r, { x: 12, y: 8, width: 101, height: 99 })).toBe(true);
    expect(nearRect(r, { x: 13, y: 10, width: 100, height: 100 })).toBe(false);
    expect(nearRect(r, { x: 10, y: 10, width: 150, height: 150 })).toBe(false);
  });
});

describe('WindowTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const api = new FakeApi();
    const changes: WindowPlacement[] = [];
    const logs: string[] = [];
    const tracker = new WindowTracker({ api, hwnd: HWND, screenToDip: mixedDpi, onChange: (p) => changes.push(p), log: (m) => logs.push(m) });
    return { api, tracker, changes, logs };
  }

  it('polls about twice a second while idle and about 30 times a second while active', () => {
    expect(trackInterval(false)).toBe(TRACK_IDLE_MS);
    expect(trackInterval(true)).toBe(TRACK_ACTIVE_MS);
    expect(1000 / TRACK_IDLE_MS).toBe(2);
    expect(Math.round(1000 / TRACK_ACTIVE_MS)).toBe(30);
  });

  it('reads the window at start, without reporting it, then polls slowly', () => {
    const { api, tracker, changes } = setup();
    expect(tracker.placement).toBeNull();
    expect(tracker.start()).toEqual({ state: 'shown', bounds: { x: 100, y: 50, width: 1200, height: 800 } });
    expect(tracker.placement).toEqual({ state: 'shown', bounds: { x: 100, y: 50, width: 1200, height: 800 } });
    expect(api.reads).toBe(1);
    vi.advanceTimersByTime(TRACK_IDLE_MS - 1);
    expect(api.reads).toBe(1);
    vi.advanceTimersByTime(1);
    expect(api.reads).toBe(2);
    vi.advanceTimersByTime(TRACK_IDLE_MS * 4);
    expect(api.reads).toBe(6);
    expect(changes).toEqual([]); // nothing moved
  });

  it('turning active reads at once and polls fast; inactive again goes back to slow', () => {
    const { api, tracker } = setup();
    tracker.start();
    vi.advanceTimersByTime(100);
    tracker.setActive(true);
    expect(api.reads).toBe(2); // read now: the window may have moved since the last slow poll
    vi.advanceTimersByTime(1000);
    expect(api.reads).toBe(2 + Math.floor(1000 / TRACK_ACTIVE_MS));
    tracker.setActive(true); // already active: no extra read
    expect(api.reads).toBe(2 + Math.floor(1000 / TRACK_ACTIVE_MS));
    tracker.setActive(false);
    const before = api.reads;
    vi.advanceTimersByTime(1000);
    expect(api.reads - before).toBe(1000 / TRACK_IDLE_MS);
  });

  it('reports each move, in DIPs, and only changes', () => {
    const { api, tracker, changes } = setup();
    tracker.start();
    tracker.setActive(true);
    api.bounds = { x: 1920 + 150, y: 300, width: 900, height: 600 }; // dragged onto the 150 % monitor
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    vi.advanceTimersByTime(TRACK_ACTIVE_MS * 5);
    expect(changes).toEqual([{ state: 'shown', bounds: { x: 2020, y: 200, width: 600, height: 400 } }]);
    expect(tracker.placement).toEqual(changes[0]);
  });

  it('reports hidden when minimized and shown again when restored, still polling meanwhile', () => {
    const { api, tracker, changes } = setup();
    tracker.start();
    api.iconic = true;
    vi.advanceTimersByTime(TRACK_IDLE_MS);
    expect(changes).toEqual([{ state: 'hidden' }]);
    vi.advanceTimersByTime(TRACK_IDLE_MS * 3);
    expect(changes).toHaveLength(1);
    api.iconic = false;
    vi.advanceTimersByTime(TRACK_IDLE_MS);
    expect(changes).toEqual([{ state: 'hidden' }, { state: 'shown', bounds: { x: 100, y: 50, width: 1200, height: 800 } }]);
  });

  it('stops by itself when the window closes, reporting gone once', () => {
    const { api, tracker, changes } = setup();
    tracker.start();
    tracker.setActive(true);
    api.exists = false;
    vi.advanceTimersByTime(TRACK_ACTIVE_MS);
    expect(changes).toEqual([{ state: 'gone' }]);
    expect(tracker.stopped).toBe(true);
    const reads = api.reads;
    vi.advanceTimersByTime(10_000);
    tracker.setActive(false);
    tracker.setActive(true);
    expect(api.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a window already gone at start is not followed', () => {
    const { api, tracker } = setup();
    api.exists = false;
    expect(tracker.start()).toEqual({ state: 'gone' });
    expect(tracker.stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() ends the polling (the share ended)', () => {
    const { api, tracker } = setup();
    tracker.start();
    tracker.setActive(true);
    tracker.stop();
    const reads = api.reads;
    vi.advanceTimersByTime(10_000);
    expect(api.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls that throw end the following, with a log line and no details', () => {
    const { api, tracker, changes, logs } = setup();
    tracker.start();
    api.frameBounds = () => {
      throw new Error('ffi: something deep');
    };
    vi.advanceTimersByTime(TRACK_IDLE_MS);
    expect(changes).toEqual([{ state: 'gone' }]);
    expect(tracker.stopped).toBe(true);
    expect(logs).toEqual(['[draw] the shared window could not be read; no overlay over it']);
  });
});
