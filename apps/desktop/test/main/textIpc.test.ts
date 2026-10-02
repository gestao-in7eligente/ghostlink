import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc, FORBIDDEN_REQUEST_TYPES, RENDERER_REQUEST_TYPES } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const TOP = { url: 'app://ghostlink/index.html', parent: null };
const CHANNEL = 'A'.repeat(26);

let request: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;
let copyText: ReturnType<typeof vi.fn>;
let show: ReturnType<typeof vi.fn>;
let showWindow: ReturnType<typeof vi.fn>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  request = vi.fn(async (type: string, payload: unknown, serverId?: string) => ({ type, payload, ...(serverId ? { serverId } : {}) }));
  openExternal = vi.fn(async () => true);
  copyText = vi.fn();
  show = vi.fn(() => true);
  showWindow = vi.fn();
  registerIpc({
    appOrigin: 'app://ghostlink',
    controller: { request },
    shell: { openExternal, copyText },
    notifications: { show },
    showWindow,
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

  it.each([
    ...FORBIDDEN_REQUEST_TYPES,
    'res',
    'error',
    'welcome',
    'challenge',
    'msg.new',
    'voice.state',
    'upload.begin',
    'files.url',
    // A bot's own requests: never from a person's app.
    'commands.set',
    'interaction.respond',
    'interaction.edit',
    'interaction.followup',
    'a'.repeat(64),
  ])(
    'refuses %s: only the client requests of spec §5.2 get through',
    async (type) => {
      expect(await invoke(IPC.serverRequest, TOP, type, {})).toEqual({ ok: false, code: 'BAD_REQUEST' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('allows every text and voice request of spec §5.2, and ping', () => {
    for (const t of ['msg.send', 'msg.history', 'channel.read', 'typing', 'role.reorder', 'member.ban', 'bans.list', 'invite.create', 'server.leave', 'profile.update']) {
      expect(RENDERER_REQUEST_TYPES.has(t), t).toBe(true);
    }
    for (const t of ['voice.join', 'voice.leave', 'voice.selfState', 'voice.moderate', 'ping']) expect(RENDERER_REQUEST_TYPES.has(t), t).toBe(true);
    for (const t of ['bot.create', 'bot.regenerate', 'bot.delete', 'bot.list', 'bot.get', 'bot.update', 'interaction.invoke']) expect(RENDERER_REQUEST_TYPES.has(t), t).toBe(true);
    for (const t of FORBIDDEN_REQUEST_TYPES) expect(RENDERER_REQUEST_TYPES.has(t)).toBe(false);
  });

  it('passes the expected server id along, so main can refuse a request meant for another server', async () => {
    expect(await invoke(IPC.serverRequest, TOP, 'msg.send', { content: 'oi' }, 'srv-1')).toEqual({
      ok: true,
      value: { type: 'msg.send', payload: { content: 'oi' }, serverId: 'srv-1' },
    });
    expect(await invoke(IPC.serverRequest, TOP, 'msg.send', { content: 'oi' }, '')).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it.each<[string, unknown[]]>([
    ['a 65-character type', ['a'.repeat(65), {}]],
    ['an empty type', ['', {}]],
    ['a type with spaces', ['msg send', {}]],
    ['a non-string type', [42, {}]],
    ['an array payload', ['msg.send', [1, 2]]],
    ['a string payload', ['msg.send', 'x']],
    ['a payload bigger than a frame', ['msg.send', { content: 'x'.repeat(300 * 1024) }]],
    ['a payload of few characters but more bytes than a frame', ['msg.send', { content: '漢'.repeat(100 * 1024) }]],
    ['a non-string server id', ['msg.send', {}, 42]],
    ['an extra argument', ['msg.send', {}, 'srv-1', 'more']],
  ])('refuses %s', async (_label, args) => {
    expect(await invoke(IPC.serverRequest, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });

  it('passes server error codes through', async () => {
    request.mockRejectedValueOnce(new ProtocolError('NOT_FOUND'));
    expect(await invoke(IPC.serverRequest, TOP, 'msg.history', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
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
    const n = { server: 'Casa', channel: 'geral', author: 'Ana', body: 'oi', serverIcon: null, channelId: CHANNEL };
    expect(await invoke(IPC.notificationsShow, TOP, n)).toEqual({ ok: true, value: true });
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, serverIcon: 'ab'.repeat(32) })).toEqual({ ok: true, value: true });
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, channelId: '../x' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    // The picture is only ever a hash main serves itself, never a URL or a path.
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, serverIcon: 'file:///C:/x.png' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.notificationsShow, TOP, { ...n, icon: 'file:///C:/x.png' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(show).toHaveBeenCalledTimes(2);
  });
});

describe("app.showWindow (the call's mini window brings GhostLink back)", () => {
  it('brings the main window to the front for the app page only, without arguments', async () => {
    expect(await invoke(IPC.appShowWindow, TOP)).toEqual({ ok: true, value: undefined });
    expect(showWindow).toHaveBeenCalledOnce();
    expect(await invoke(IPC.appShowWindow, TOP, 'x')).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.appShowWindow, { url: 'about:blank', parent: null })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(showWindow).toHaveBeenCalledOnce();
  });
});
