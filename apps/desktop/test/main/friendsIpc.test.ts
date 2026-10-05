import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const KEY = toBase64Url(new Uint8Array(32).fill(7));
const CODE = 'GLF1-AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYP7-B4PS-6P2P-L5XX-7D47-V674-7X7P-7OSD-VNOA';
const SNAPSHOT = { revision: 3, running: true, available: true, code: CODE, inboxEnabled: true, friends: [] };

type Method = 'state' | 'add' | 'accept' | 'dismiss' | 'remove' | 'block' | 'rename' | 'newCode' | 'setInbox' | 'setAvailable';
let friends: Record<Method, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  const method = () => vi.fn(async () => SNAPSHOT);
  friends = {
    state: method(), add: method(), accept: method(), dismiss: method(), remove: method(),
    block: method(), rename: method(), newCode: method(), setInbox: method(), setAvailable: method(),
  };
  registerIpc({ appOrigin: APP, friends } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('friends IPC (v0.3)', () => {
  it('calls the engine for the app page and answers with its snapshot', async () => {
    const ok = { ok: true, value: SNAPSHOT };
    expect(await invoke(IPC.friendsState, TOP)).toEqual(ok);
    expect(await invoke(IPC.friendsAdd, TOP, CODE)).toEqual(ok);
    expect(friends.add).toHaveBeenCalledWith(CODE);
    for (const [channel, method] of [[IPC.friendsAccept, 'accept'], [IPC.friendsDismiss, 'dismiss'], [IPC.friendsRemove, 'remove'], [IPC.friendsBlock, 'block']] as const) {
      expect(await invoke(channel, TOP, KEY)).toEqual(ok);
      expect(friends[method]).toHaveBeenCalledWith(KEY);
    }
    expect(await invoke(IPC.friendsRename, TOP, KEY, 'Bia do trabalho')).toEqual(ok);
    expect(friends.rename).toHaveBeenLastCalledWith(KEY, 'Bia do trabalho');
    expect(await invoke(IPC.friendsRename, TOP, KEY, null)).toEqual(ok);
    expect(friends.rename).toHaveBeenLastCalledWith(KEY, null);
    expect(await invoke(IPC.friendsNewCode, TOP)).toEqual(ok);
    expect(await invoke(IPC.friendsSetInbox, TOP, false)).toEqual(ok);
    expect(friends.setInbox).toHaveBeenCalledWith(false);
    expect(await invoke(IPC.friendsSetAvailable, TOP, true)).toEqual(ok);
    expect(friends.setAvailable).toHaveBeenCalledWith(true);
  });

  it('trims the local nickname before main sees it', async () => {
    await invoke(IPC.friendsRename, TOP, KEY, '  Bia  ');
    expect(friends.rename).toHaveBeenCalledWith(KEY, 'Bia');
  });

  it('hands a pasted code over as it is: main checks it', async () => {
    const pasted = `  ${CODE.toLowerCase()}\n`;
    await invoke(IPC.friendsAdd, TOP, pasted);
    expect(friends.add).toHaveBeenCalledWith(pasted);
  });

  it('refuses other frames before touching the engine', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.friendsState, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.friendsAdd, frame, CODE)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.friendsAccept, frame, KEY)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.friendsNewCode, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.friendsSetAvailable, frame, false)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    for (const fn of Object.values(friends)) expect(fn).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['an argument to state', IPC.friendsState, [{}]],
    ['no code', IPC.friendsAdd, []],
    ['a code that is not a string', IPC.friendsAdd, [{ code: CODE }]],
    ['a code over 200 characters', IPC.friendsAdd, ['G'.repeat(201)]],
    ['two codes', IPC.friendsAdd, [CODE, CODE]],
    ['no key', IPC.friendsAccept, []],
    ['a key of 42 characters', IPC.friendsAccept, [KEY.slice(1)]],
    ['a key of 44 characters', IPC.friendsAccept, [`${KEY}A`]],
    ['a key in standard base64', IPC.friendsDismiss, [`${KEY.slice(0, 42)}+`]],
    ['a key with padding', IPC.friendsRemove, [`${KEY.slice(0, 42)}=`]],
    ['a key with a line break', IPC.friendsBlock, [`${KEY.slice(0, 42)}\n`]],
    ['a key that is not a string', IPC.friendsBlock, [new Uint8Array(32)]],
    ['a key as an object', IPC.friendsRemove, [{ key: KEY }]],
    ['a friend code where a key goes', IPC.friendsAccept, [CODE]],
    ['an extra argument to accept', IPC.friendsAccept, [KEY, true]],
    ['rename without a name', IPC.friendsRename, [KEY]],
    ['rename with undefined', IPC.friendsRename, [KEY, undefined]],
    ['an empty local nickname', IPC.friendsRename, [KEY, '']],
    ['a blank local nickname', IPC.friendsRename, [KEY, '   ']],
    ['a local nickname of 33 characters', IPC.friendsRename, [KEY, 'x'.repeat(33)]],
    ['a local nickname that is not a string', IPC.friendsRename, [KEY, 7]],
    ['rename with a bad key', IPC.friendsRename, ['nope', 'Bia']],
    ['an argument to newCode', IPC.friendsNewCode, [CODE]],
    ['setInbox without a value', IPC.friendsSetInbox, []],
    ['setInbox with a string', IPC.friendsSetInbox, ['false']],
    ['setInbox with a number', IPC.friendsSetInbox, [0]],
    ['setAvailable with null', IPC.friendsSetAvailable, [null]],
    ['setAvailable with two values', IPC.friendsSetAvailable, [true, false]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of Object.values(friends)) expect(fn).not.toHaveBeenCalled();
  });

  it('takes a local nickname of exactly 32 characters', async () => {
    expect(await invoke(IPC.friendsRename, TOP, KEY, 'x'.repeat(32))).toEqual({ ok: true, value: SNAPSHOT });
  });

  it('passes the friends error codes through, and hides anything else behind INTERNAL', async () => {
    for (const code of ['FRIEND_CODE_INVALID', 'FRIEND_SELF', 'FRIEND_LIMIT', 'P2P_UNAVAILABLE'] as const) {
      friends.add.mockRejectedValueOnce(new AppError(code));
      expect(await invoke(IPC.friendsAdd, TOP, CODE)).toEqual({ ok: false, code });
    }
    friends.accept.mockRejectedValueOnce(new Error('SQLITE_FULL: database or disk is full'));
    expect(await invoke(IPC.friendsAccept, TOP, KEY)).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('answers INTERNAL when the engine is not wired', async () => {
    electron.ipcMain.handle.mockReset();
    registerIpc({ appOrigin: APP } as unknown as Deps);
    expect(await invoke(IPC.friendsState, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
  });
});
