import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { DM_TEXT_MAX } from '../../src/shared/dmTypes.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
const { DM_HISTORY_LIMIT_MAX } = await import('../../src/main/dmIpc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const KEY = toBase64Url(new Uint8Array(32).fill(7));
const CONV = 'c0'.repeat(16);
const ID = 'ab'.repeat(16);
const CONVERSATION = { id: CONV, kind: 'dm', peer: KEY, lastTs: null, lastText: null, unread: 0, hidden: false };
const HASH = 'ef'.repeat(32);
const FILE = { hash: HASH, name: 'foto.png', size: 3, kind: 'image', mime: 'image/png', width: 1, height: 1 };
const MESSAGE = { id: ID, conv: CONV, author: KEY, mine: true, ts: 1, text: 'oi', replyTo: null, editedAt: null, deleted: false, delivered: false, attachments: [] };

type Method = 'conversations' | 'open' | 'hide' | 'history' | 'send' | 'edit' | 'remove' | 'read' | 'typing' | 'attach' | 'fetchFile' | 'saveFile';
let dm: Record<Method, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  dm = {
    conversations: vi.fn(async () => [CONVERSATION]),
    open: vi.fn(async () => CONVERSATION),
    hide: vi.fn(async () => undefined),
    history: vi.fn(async () => [MESSAGE]),
    send: vi.fn(async () => MESSAGE),
    edit: vi.fn(async () => MESSAGE),
    remove: vi.fn(async () => MESSAGE),
    read: vi.fn(async () => undefined),
    typing: vi.fn(async () => undefined),
    attach: vi.fn(async () => FILE),
    fetchFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => true),
  };
  registerIpc({ appOrigin: APP, dm } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('direct-message IPC (v0.3 phase 2)', () => {
  it('calls the engine for the app page and answers with what it returns', async () => {
    expect(await invoke(IPC.dmConversations, TOP)).toEqual({ ok: true, value: [CONVERSATION] });
    expect(await invoke(IPC.dmOpen, TOP, KEY)).toEqual({ ok: true, value: CONVERSATION });
    expect(dm.open).toHaveBeenCalledWith(KEY);
    expect(await invoke(IPC.dmHide, TOP, CONV)).toEqual({ ok: true, value: undefined });
    expect(dm.hide).toHaveBeenCalledWith(CONV);
    expect(await invoke(IPC.dmHistory, TOP, CONV, null, 50)).toEqual({ ok: true, value: [MESSAGE] });
    expect(dm.history).toHaveBeenLastCalledWith(CONV, null, 50);
    expect(await invoke(IPC.dmHistory, TOP, CONV, 1_700_000_000_000, DM_HISTORY_LIMIT_MAX)).toEqual({ ok: true, value: [MESSAGE] });
    expect(dm.history).toHaveBeenLastCalledWith(CONV, 1_700_000_000_000, DM_HISTORY_LIMIT_MAX);
    expect(await invoke(IPC.dmSend, TOP, CONV, 'oi', null, [])).toEqual({ ok: true, value: MESSAGE });
    expect(dm.send).toHaveBeenLastCalledWith(CONV, 'oi', null, []);
    expect(await invoke(IPC.dmSend, TOP, CONV, 'resposta', ID, [])).toEqual({ ok: true, value: MESSAGE });
    expect(dm.send).toHaveBeenLastCalledWith(CONV, 'resposta', ID, []);
    expect(await invoke(IPC.dmEdit, TOP, CONV, ID, 'oi!')).toEqual({ ok: true, value: MESSAGE });
    expect(dm.edit).toHaveBeenCalledWith(CONV, ID, 'oi!');
    expect(await invoke(IPC.dmRemove, TOP, CONV, ID)).toEqual({ ok: true, value: MESSAGE });
    expect(dm.remove).toHaveBeenCalledWith(CONV, ID);
    expect(await invoke(IPC.dmRead, TOP, CONV, 1_700_000_000_000)).toEqual({ ok: true, value: undefined });
    expect(dm.read).toHaveBeenCalledWith(CONV, 1_700_000_000_000);
    expect(await invoke(IPC.dmTyping, TOP, CONV)).toEqual({ ok: true, value: undefined });
    expect(dm.typing).toHaveBeenCalledWith(CONV);
    expect(await invoke(IPC.dmSend, TOP, CONV, '', null, [{ hash: HASH, name: 'foto.png' }])).toEqual({ ok: true, value: MESSAGE });
    expect(dm.send).toHaveBeenLastCalledWith(CONV, '', null, [{ hash: HASH, name: 'foto.png' }]);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await invoke(IPC.dmAttach, TOP, CONV, 'foto.png', bytes)).toEqual({ ok: true, value: FILE });
    expect(dm.attach).toHaveBeenCalledWith(CONV, 'foto.png', bytes);
    expect(await invoke(IPC.dmFetchFile, TOP, CONV, HASH)).toEqual({ ok: true, value: undefined });
    expect(dm.fetchFile).toHaveBeenCalledWith(CONV, HASH);
    expect(await invoke(IPC.dmSaveFile, TOP, CONV, HASH)).toEqual({ ok: true, value: true });
    expect(dm.saveFile).toHaveBeenCalledWith(CONV, HASH);
  });

  it('hands text over as it is: main cleans it and checks its length', async () => {
    const text = `  oi\r\n${'x'.repeat(DM_TEXT_MAX)}  `;
    await invoke(IPC.dmSend, TOP, CONV, text, null, []);
    expect(dm.send).toHaveBeenCalledWith(CONV, text, null, []);
    await invoke(IPC.dmSend, TOP, CONV, '', null, []);
    expect(dm.send).toHaveBeenLastCalledWith(CONV, '', null, []);
  });

  it('refuses other frames before touching the engine', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.dmConversations, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.dmOpen, frame, KEY)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.dmHistory, frame, CONV, null, 50)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.dmSend, frame, CONV, 'oi', null)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    for (const fn of Object.values(dm)) expect(fn).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['an argument to conversations', IPC.dmConversations, [CONV]],
    ['open without a key', IPC.dmOpen, []],
    ['open with a key of 42 characters', IPC.dmOpen, [KEY.slice(1)]],
    ['open with a key in standard base64', IPC.dmOpen, [`${KEY.slice(0, 42)}+`]],
    ['open with a conversation id', IPC.dmOpen, [CONV]],
    ['open with a key as bytes', IPC.dmOpen, [new Uint8Array(32)]],
    ['hide without a conversation', IPC.dmHide, []],
    ['a conversation id in upper case', IPC.dmHide, [CONV.toUpperCase()]],
    ['a conversation id of 31 characters', IPC.dmHide, [CONV.slice(1)]],
    ['a conversation id of 33 characters', IPC.dmHide, [`${CONV}0`]],
    ['a conversation id with a line break', IPC.dmHide, [`${CONV.slice(1)}\n`]],
    ['a conversation id as an object', IPC.dmHide, [{ id: CONV }]],
    ['history without a limit', IPC.dmHistory, [CONV, null]],
    ['history with undefined before', IPC.dmHistory, [CONV, undefined, 50]],
    ['history with before as text', IPC.dmHistory, [CONV, '123', 50]],
    ['history with an infinite before', IPC.dmHistory, [CONV, Infinity, 50]],
    ['history with NaN before', IPC.dmHistory, [CONV, NaN, 50]],
    ['history with a limit of 0', IPC.dmHistory, [CONV, null, 0]],
    ['history with a limit of 201', IPC.dmHistory, [CONV, null, 201]],
    ['history with a fractional limit', IPC.dmHistory, [CONV, null, 2.5]],
    ['history with an extra argument', IPC.dmHistory, [CONV, null, 50, true]],
    ['send without a reply argument', IPC.dmSend, [CONV, 'oi']],
    ['send without the files', IPC.dmSend, [CONV, 'oi', null]],
    ['send with eleven files', IPC.dmSend, [CONV, '', null, Array.from({ length: 11 }, () => ({ hash: HASH, name: 'a' }))]],
    ['send with a file hash that is not one', IPC.dmSend, [CONV, '', null, [{ hash: HASH.slice(1), name: 'a' }]]],
    ['send with a file without a name', IPC.dmSend, [CONV, '', null, [{ hash: HASH, name: '' }]]],
    ['send with a file carrying a path', IPC.dmSend, [CONV, '', null, [{ hash: HASH, name: 'a', path: 'C:/x' }]]],
    ['attach without bytes', IPC.dmAttach, [CONV, 'a.png']],
    ['attach with no bytes at all', IPC.dmAttach, [CONV, 'a.png', new Uint8Array(0)]],
    ['attach with bytes as an array', IPC.dmAttach, [CONV, 'a.png', [1, 2, 3]]],
    ['attach with a name that is too long', IPC.dmAttach, [CONV, 'a'.repeat(1025), new Uint8Array(1)]],
    ['fetchFile with a bad hash', IPC.dmFetchFile, [CONV, 'x']],
    ['saveFile with a hash in upper case', IPC.dmSaveFile, [CONV, HASH.toUpperCase()]],
    ['send with text that is not a string', IPC.dmSend, [CONV, 42, null]],
    ['send with text as an object', IPC.dmSend, [CONV, { text: 'oi' }, null]],
    ['send with a huge text', IPC.dmSend, [CONV, 'x'.repeat(2 * DM_TEXT_MAX + 1), null]],
    ['send replying to something that is not an id', IPC.dmSend, [CONV, 'oi', 'x']],
    ['send replying with undefined', IPC.dmSend, [CONV, 'oi', undefined]],
    ['edit without text', IPC.dmEdit, [CONV, ID]],
    ['edit with a bad message id', IPC.dmEdit, [CONV, ID.toUpperCase(), 'oi']],
    ['remove with a bad message id', IPC.dmRemove, [CONV, 'nope']],
    ['remove with an extra argument', IPC.dmRemove, [CONV, ID, true]],
    ['read without ts', IPC.dmRead, [CONV]],
    ['read with ts as text', IPC.dmRead, [CONV, '1']],
    ['read with an infinite ts', IPC.dmRead, [CONV, -Infinity]],
    ['read with a null ts', IPC.dmRead, [CONV, null]],
    ['typing with a bad conversation', IPC.dmTyping, ['x']],
    ['typing with an extra argument', IPC.dmTyping, [CONV, 'oi']],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of Object.values(dm)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes the engine error codes through, and hides anything else behind INTERNAL', async () => {
    for (const code of ['P2P_UNAVAILABLE', 'NOT_FOUND', 'FORBIDDEN', 'BAD_REQUEST'] as const) {
      dm.send.mockRejectedValueOnce(new AppError(code));
      expect(await invoke(IPC.dmSend, TOP, CONV, 'oi', null, [])).toEqual({ ok: false, code });
    }
    dm.history.mockRejectedValueOnce(new Error('SQLITE_FULL: database or disk is full'));
    expect(await invoke(IPC.dmHistory, TOP, CONV, null, 50)).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('answers INTERNAL when the engine is not wired', async () => {
    electron.ipcMain.handle.mockReset();
    registerIpc({ appOrigin: APP } as unknown as Deps);
    expect(await invoke(IPC.dmConversations, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
  });
});
