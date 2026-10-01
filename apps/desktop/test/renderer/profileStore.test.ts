import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarInfo, ProfileApi } from '../../src/shared/profileTypes.js';
import { avatarHashFor, useProfileStore } from '../../src/renderer/stores/profile.js';

const A: AvatarInfo = { hash: 'a'.repeat(64), mime: 'image/webp' };
const B: AvatarInfo = { hash: 'b'.repeat(64), mime: 'image/gif' };

let api: { [K in keyof ProfileApi]: ReturnType<typeof vi.fn> };

function install(stored: AvatarInfo | null = A) {
  api = {
    avatar: vi.fn(async () => stored),
    setAvatar: vi.fn(async () => B),
    clearAvatar: vi.fn(async () => null),
    setServerIcon: vi.fn(async () => B),
  };
  (globalThis as { window?: unknown }).window = { ghostlink: { profile: api } };
}

beforeEach(() => {
  useProfileStore.setState(useProfileStore.getInitialState());
  install();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const state = () => useProfileStore.getState();

describe('the profile store (my photo, from main)', () => {
  it('starts idle and loads my photo once, even when asked twice at the same time', async () => {
    expect(state()).toMatchObject({ status: 'idle', avatar: null });
    await Promise.all([state().load(), state().load()]);
    expect(api.avatar).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ status: 'ready', avatar: A });
  });

  it('knows when I have no photo', async () => {
    install(null);
    await state().load();
    expect(state()).toMatchObject({ status: 'ready', avatar: null });
  });

  it('a failed load is marked failed and can be tried again', async () => {
    api.avatar.mockRejectedValueOnce(new Error('INTERNAL'));
    await state().load();
    expect(state().status).toBe('failed');
    await state().load();
    expect(state()).toMatchObject({ status: 'ready', avatar: A });
  });

  it('set stores the new photo at once and returns it', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await state().set(bytes)).toEqual(B);
    expect(api.setAvatar).toHaveBeenCalledWith(bytes);
    expect(state()).toMatchObject({ status: 'ready', avatar: B });
  });

  it('a refused set keeps the photo I had', async () => {
    await state().load();
    api.setAvatar.mockRejectedValueOnce(new Error('BAD_REQUEST'));
    await expect(state().set(new Uint8Array([1]))).rejects.toThrow('BAD_REQUEST');
    expect(state().avatar).toEqual(A);
  });

  it('clear goes back to initials', async () => {
    await state().load();
    await state().clear();
    expect(api.clearAvatar).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ status: 'ready', avatar: null });
  });

  it('a load answered after a change does not bring the old photo back', async () => {
    let answer: (info: AvatarInfo | null) => void = () => {};
    api.avatar.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const loading = state().load();
    await state().set(new Uint8Array([9]));
    answer(A);
    await loading;
    expect(state()).toMatchObject({ status: 'ready', avatar: B });
  });
});

describe('avatarHashFor (my own photo shows from the store, everyone else from the server)', () => {
  it('uses the store for me once it is loaded, including "no photo"', () => {
    expect(avatarHashFor(true, B.hash, { status: 'ready', avatar: A })).toBe(A.hash);
    expect(avatarHashFor(true, B.hash, { status: 'ready', avatar: null })).toBeNull();
  });

  it("falls back to the server's member while the store is not ready", () => {
    for (const status of ['idle', 'loading', 'failed'] as const) expect(avatarHashFor(true, B.hash, { status, avatar: null }), status).toBe(B.hash);
  });

  it("uses the server's member for anyone else", () => {
    expect(avatarHashFor(false, B.hash, { status: 'ready', avatar: A })).toBe(B.hash);
    expect(avatarHashFor(false, null, { status: 'ready', avatar: A })).toBeNull();
    expect(avatarHashFor(false, undefined, { status: 'ready', avatar: A })).toBeNull();
  });
});
