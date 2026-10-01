import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';
import { useTempDir } from '../helpers/tempDir.js';
import { gif, png, sha256Hex, webp } from './avatarFixtures.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
const { createAvatars } = await import('../../src/main/avatars/index.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const tmp = useTempDir();

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

function wire(profile: Deps['profile']) {
  electron.ipcMain.handle.mockReset();
  registerIpc({ appOrigin: APP, profile } as unknown as Deps);
}

let warnings: string[];
beforeEach(() => {
  warnings = [];
  wire(createAvatars({ userDataDir: tmp.path, warn: (m) => warnings.push(m) }).profile);
});

describe('profile IPC (spec 2026-10-01 §3)', () => {
  it('stores, reads and clears my photo; the answers carry the hash and the type, never a path', async () => {
    expect(await invoke(IPC.profileAvatar, TOP)).toEqual({ ok: true, value: null });
    const bytes = webp();
    const info = { hash: sha256Hex(bytes), mime: 'image/webp' };
    const set = await invoke(IPC.profileSetAvatar, TOP, bytes);
    expect(set).toEqual({ ok: true, value: info });
    expect(Object.keys((set as { value: object }).value).sort()).toEqual(['hash', 'mime']);
    expect(await invoke(IPC.profileAvatar, TOP)).toEqual({ ok: true, value: info });
    expect(readdirSync(join(tmp.path, 'profile')).sort()).toEqual(['avatar.json', 'avatar.webp']);
    expect(await invoke(IPC.profileClearAvatar, TOP)).toEqual({ ok: true, value: null });
    expect(await invoke(IPC.profileAvatar, TOP)).toEqual({ ok: true, value: null });
  });

  it('takes an animated photo as GIF', async () => {
    const bytes = gif(256, 256, { size: 100_000 });
    expect(await invoke(IPC.profileSetAvatar, TOP, bytes)).toEqual({ ok: true, value: { hash: sha256Hex(bytes), mime: 'image/gif' } });
  });

  it('refuses a photo main would not have produced with BAD_REQUEST', async () => {
    for (const bytes of [png(), webp(128), gif(256, 255)]) {
      expect(await invoke(IPC.profileSetAvatar, TOP, bytes)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    }
    expect(await invoke(IPC.profileAvatar, TOP)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['no bytes', []],
    ['empty bytes', [new Uint8Array(0)]],
    ['more than 2 MB', [webp(256, 256, { size: AVATAR_LIMITS.maxBytes + 1 })]],
    ['a string', ['webp']],
    ['a plain array', [[...webp()]]],
    ['an ArrayBuffer', [webp().buffer]],
    ['an extra argument', [webp(), 'extra']],
  ])('validates setAvatar’s argument before main sees it: %s', async (_label, args) => {
    const profile = { avatar: vi.fn(), setAvatar: vi.fn(), clearAvatar: vi.fn() };
    wire(profile);
    expect(await invoke(IPC.profileSetAvatar, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(profile.setAvatar).not.toHaveBeenCalled();
  });

  it('takes no arguments for avatar() and clearAvatar()', async () => {
    expect(await invoke(IPC.profileAvatar, TOP, 'x')).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.profileClearAvatar, TOP, {})).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('refuses other frames and origins before touching the store', async () => {
    const profile = { avatar: vi.fn(), setAvatar: vi.fn(), clearAvatar: vi.fn() };
    wire(profile);
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const elsewhere = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, elsewhere, null]) {
      expect(await invoke(IPC.profileSetAvatar, frame, webp())).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.profileClearAvatar, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.profileAvatar, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(profile.setAvatar).not.toHaveBeenCalled();
    expect(profile.clearAvatar).not.toHaveBeenCalled();
    expect(profile.avatar).not.toHaveBeenCalled();
  });

  it('answers setAvatar before any upload: no connection is needed', async () => {
    const bytes = webp();
    expect(await invoke(IPC.profileSetAvatar, TOP, bytes)).toEqual({ ok: true, value: { hash: sha256Hex(bytes), mime: 'image/webp' } });
    expect(warnings).toEqual([]);
  });
});
