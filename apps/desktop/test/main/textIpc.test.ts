import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc, FORBIDDEN_REQUEST_TYPES } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const TOP = { url: 'app://ghostlink/index.html', parent: null };
const CHANNEL = 'A'.repeat(26);

let request: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;
let copyText: ReturnType<typeof vi.fn>;
let show: ReturnType<typeof vi.fn>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  request = vi.fn(async (type: string, payload: unknown) => ({ type, payload }));
  openExternal = vi.fn(async () => true);
  copyText = vi.fn();
  show = vi.fn(() => true);
  registerIpc({
    appOrigin: 'app://ghostlink',
    controller: { request },
    shell: { openExternal, copyText },
    notifications: { show },
  } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('server.request (generic renderer → server requests)', () => {
  it('relays a request and its payload', async () => {
    expect(await invoke(IPC.serverRequest, TOP, 'msg.send', { channelId: CHANNEL, content: 'oi' })).toEqual({
      ok: true,
      value: { type: 'msg.send', payload: { channelId: CHANNEL, content: 'oi' } },
    });
    expect(await invoke(IPC.serverRequest, TOP, 'bans.list')).toEqual({ ok: true, value: { type: 'bans.list', payload: {} } });
  });

  it.each([...FORBIDDEN_REQUEST_TYPES])('refuses the handshake step %s', async (type) => {
    expect(await invoke(IPC.serverRequest, TOP, type, {})).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each<[string, unknown[]]>([
    ['a 65-character type', ['a'.repeat(65), {}]],
    ['an empty type', ['', {}]],
    ['a type with spaces', ['msg send', {}]],
    ['a non-string type', [42, {}]],
    ['an array payload', ['msg.send', [1, 2]]],
    ['a string payload', ['msg.send', 'x']],
    ['a payload bigger than a frame', ['msg.send', { content: 'x'.repeat(300 * 1024) }]],
    ['an extra argument', ['msg.send', {}, 'more']],
  ])('refuses %s', async (_label, args) => {
    expect(await invoke(IPC.serverRequest, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts a 64-character type and passes server error codes through', async () => {
    request.mockRejectedValueOnce(new ProtocolError('NOT_FOUND'));
    expect(await invoke(IPC.serverRequest, TOP, 'a'.repeat(64), {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('is refused to other frames', async () => {
    expect(await invoke(IPC.serverRequest, { url: 'https://evil.example/', parent: null }, 'msg.send', {})).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('app.openExternal, app.copyText and notifications.show', () => {
  it('validates the arguments before calling through', async () => {
    expect(await invoke(IPC.appOpenExternal, TOP, 'https://example.com')).toEqual({ ok: true, value: true });
    expect(await invoke(IPC.appOpenExternal, TOP, 'x'.repeat(2049))).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.appCopyText, TOP, 'https://site/j/#GL1-abc')).toEqual({ ok: true, value: undefined });
    expect(copyText).toHaveBeenCalledWith('https://site/j/#GL1-abc');
    expect(await invoke(IPC.appCopyText, TOP, 'x'.repeat(8193))).toEqual({ ok: false, code: 'BAD_REQUEST' });
    const n = { title: 'Ana', body: 'oi', channelId: CHANNEL };
    expect(await invoke(IPC.notificationsShow, TOP, n)).toEqual({ ok: true, value: true });
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, channelId: '../x' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, icon: 'file:///C:/x.png' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(show).toHaveBeenCalledOnce();
  });
});
