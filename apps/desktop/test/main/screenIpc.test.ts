import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const SOURCES = [{ id: 'screen:0:0', name: 'Tela cheia', kind: 'screen', thumbnail: 'data:image/png;base64,AA', icon: null }];
const CHOICE = { sourceId: 'window:133240:0', audio: true };

let screen: { listSources: ReturnType<typeof vi.fn>; choose: ReturnType<typeof vi.fn> };

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  screen = { listSources: vi.fn(async () => SOURCES), choose: vi.fn() };
  registerIpc({ appOrigin: APP, screen } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('screen IPC (screen sharing spec §3)', () => {
  it('lists the sources and keeps the choice for the app page', async () => {
    expect(await invoke(IPC.screenSources, TOP)).toEqual({ ok: true, value: SOURCES });
    expect(await invoke(IPC.screenChoose, TOP, CHOICE)).toEqual({ ok: true });
    expect(await invoke(IPC.screenChoose, TOP, { sourceId: 'screen:0:0', audio: false })).toEqual({ ok: true });
    expect(screen.choose.mock.calls).toEqual([[CHOICE], [{ sourceId: 'screen:0:0', audio: false }]]);
  });

  it('refuses other frames before listing or choosing', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.screenSources, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.screenChoose, frame, CHOICE)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(screen.listSources).not.toHaveBeenCalled();
    expect(screen.choose).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['an argument to sources', IPC.screenSources, [{ types: ['window'] }]],
    ['no choice', IPC.screenChoose, []],
    ['two choices', IPC.screenChoose, [CHOICE, CHOICE]],
    ['a choice that is not an object', IPC.screenChoose, ['window:133240:0']],
    ['an extra key', IPC.screenChoose, [{ ...CHOICE, name: 'Tela cheia' }]],
    ['a missing audio', IPC.screenChoose, [{ sourceId: 'screen:0:0' }]],
    ['a non-boolean audio', IPC.screenChoose, [{ ...CHOICE, audio: 'loopback' }]],
    ['a missing source id', IPC.screenChoose, [{ audio: true }]],
    ['an empty source id', IPC.screenChoose, [{ ...CHOICE, sourceId: '' }]],
    ['a tab id', IPC.screenChoose, [{ ...CHOICE, sourceId: 'tab:1:2' }]],
    ['a web contents id', IPC.screenChoose, [{ ...CHOICE, sourceId: 'web-contents-media-stream://1:2' }]],
    ['a source id with a suffix', IPC.screenChoose, [{ ...CHOICE, sourceId: 'screen:0:0\n' }]],
    ['a source id with a prefix', IPC.screenChoose, [{ ...CHOICE, sourceId: 'xscreen:0:0' }]],
    ['a huge source id', IPC.screenChoose, [{ ...CHOICE, sourceId: `window:${'1'.repeat(60)}:0` }]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(screen.listSources).not.toHaveBeenCalled();
    expect(screen.choose).not.toHaveBeenCalled();
  });

  it('hides a failed listing behind INTERNAL', async () => {
    screen.listSources.mockRejectedValueOnce(new Error('capturer gone'));
    expect(await invoke(IPC.screenSources, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('answers INTERNAL when screen sharing is not wired', async () => {
    electron.ipcMain.handle.mockReset();
    registerIpc({ appOrigin: APP } as unknown as Deps);
    expect(await invoke(IPC.screenSources, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
    expect(await invoke(IPC.screenChoose, TOP, CHOICE)).toEqual({ ok: false, code: 'INTERNAL' });
  });
});
