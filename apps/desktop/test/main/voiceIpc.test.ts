import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc, FORBIDDEN_REQUEST_TYPES } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const TOP = { url: 'app://ghostlink/index.html', parent: null };
const IFRAME = { url: 'app://ghostlink/index.html', parent: TOP };

let request: ReturnType<typeof vi.fn>;
let configure: ReturnType<typeof vi.fn>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  request = vi.fn(async (type: string, payload: unknown) => ({ type, payload }));
  configure = vi.fn(async (c: { enabled: boolean }) => ({ global: c.enabled }));
  registerIpc({ appOrigin: 'app://ghostlink', controller: { request }, ptt: { configure } } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('server.request (the renderer reaches voice.* through it)', () => {
  it('relays a voice request and its payload', async () => {
    expect(await invoke(IPC.serverRequest, TOP, 'voice.join', { channelId: 'VC1' })).toEqual({
      ok: true,
      value: { type: 'voice.join', payload: { channelId: 'VC1' } },
    });
    expect(await invoke(IPC.serverRequest, TOP, 'voice.leave')).toEqual({ ok: true, value: { type: 'voice.leave', payload: {} } });
  });

  it.each([...FORBIDDEN_REQUEST_TYPES])('refuses the handshake step %s', async (type) => {
    expect(await invoke(IPC.serverRequest, TOP, type, {})).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each<[string, unknown[]]>([
    ['a type over 64 characters', [`voice.${'x'.repeat(60)}`, {}]],
    ['a non-object payload', ['voice.join', 'VC1']],
    ['an array payload', ['voice.join', ['VC1']]],
    ['a payload bigger than a frame', ['voice.join', { channelId: 'x'.repeat(300 * 1024) }]],
  ])('refuses %s', async (_label, args) => {
    expect(await invoke(IPC.serverRequest, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses frames other than the app page', async () => {
    expect(await invoke(IPC.serverRequest, IFRAME, 'voice.join', { channelId: 'VC1' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('ptt.configure', () => {
  it('passes a validated setting to the push-to-talk module', async () => {
    expect(await invoke(IPC.pttConfigure, TOP, { enabled: true, code: 'KeyV' })).toEqual({ ok: true, value: { global: true } });
    expect(await invoke(IPC.pttConfigure, TOP, { enabled: false, code: null })).toEqual({ ok: true, value: { global: false } });
    expect(configure.mock.calls).toEqual([[{ enabled: true, code: 'KeyV' }], [{ enabled: false, code: null }]]);
  });

  it.each<[string, unknown[]]>([
    ['no argument', []],
    ['an unknown key', [{ enabled: true, code: 'KeyV', log: true }]],
    ['a code with punctuation', [{ enabled: true, code: 'Key V' }]],
    ['a long code', [{ enabled: true, code: `F${'1'.repeat(40)}` }]],
    ['a non-boolean flag', [{ enabled: 'yes', code: 'KeyV' }]],
  ])('refuses %s', async (_label, args) => {
    expect(await invoke(IPC.pttConfigure, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(configure).not.toHaveBeenCalled();
  });

  it('refuses other frames', async () => {
    expect(await invoke(IPC.pttConfigure, IFRAME, { enabled: true, code: 'KeyV' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(configure).not.toHaveBeenCalled();
  });
});
