import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc, RENDERER_REQUEST_TYPES } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const STROKE = { id: `${'b'.repeat(32)}:k3J_a-9`, color: '#FF6B6B', label: 'Bia', points: [[0.25, 0.75]], end: false };

let draw: { open: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function register(deps: Partial<Deps>): void {
  electron.ipcMain.handle.mockReset();
  registerIpc({ appOrigin: APP, ...deps } as unknown as Deps);
}

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

beforeEach(() => {
  draw = { open: vi.fn(async () => true), stroke: vi.fn(), close: vi.fn() };
  register({ draw } as unknown as Partial<Deps>);
});

describe('the pencil overlay IPC (pencil spec §4)', () => {
  it('opens, feeds and closes the overlay for the app page', async () => {
    expect(await invoke(IPC.drawOverlayOpen, TOP)).toEqual({ ok: true, value: true });
    expect(await invoke(IPC.drawOverlayStroke, TOP, STROKE)).toEqual({ ok: true });
    expect(await invoke(IPC.drawOverlayStroke, TOP, { ...STROKE, points: [], end: true })).toEqual({ ok: true });
    expect(await invoke(IPC.drawOverlayClose, TOP)).toEqual({ ok: true });
    expect(draw.stroke.mock.calls).toEqual([[STROKE], [{ ...STROKE, points: [], end: true }]]);
    expect(draw.open).toHaveBeenCalledTimes(1);
    expect(draw.close).toHaveBeenCalledTimes(1);
  });

  it('refuses other frames', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.drawOverlayOpen, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.drawOverlayStroke, frame, STROKE)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(draw.open).not.toHaveBeenCalled();
    expect(draw.stroke).not.toHaveBeenCalled();
  });

  it.each<[string, unknown[]]>([
    ['no stroke', []],
    ['an extra key', [{ ...STROKE, userId: 'b'.repeat(32) }]],
    ['an id without its author', [{ ...STROKE, id: 'k3J_a-9' }]],
    ['a color that is not #rrggbb', [{ ...STROKE, color: 'red' }]],
    ['a point outside the frame', [{ ...STROKE, points: [[1.5, 0.5]] }]],
    ['65 points', [{ ...STROKE, points: Array.from({ length: 65 }, () => [0.5, 0.5]) }]],
    ['a long label', [{ ...STROKE, label: 'x'.repeat(257) }]],
  ])('refuses a stroke with %s', async (_name, args) => {
    expect(await invoke(IPC.drawOverlayStroke, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(draw.stroke).not.toHaveBeenCalled();
  });

  it('answers "no overlay" when main has none', async () => {
    register({});
    expect(await invoke(IPC.drawOverlayOpen, TOP)).toEqual({ ok: true, value: false });
    expect(await invoke(IPC.drawOverlayStroke, TOP, STROKE)).toEqual({ ok: true });
  });

  it('lets the renderer send screen.draw and screen.drawAllow to the server', () => {
    expect(RENDERER_REQUEST_TYPES.has('screen.draw')).toBe(true);
    expect(RENDERER_REQUEST_TYPES.has('screen.drawAllow')).toBe(true);
  });
});
