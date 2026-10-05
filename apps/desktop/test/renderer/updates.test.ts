import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState, UpdatesApi } from '../../src/shared/updates.js';
import { bannerFor, syncUpdates, useUpdateStore } from '../../src/renderer/features/updates/store.js';
import { translate } from '../../src/renderer/i18n/index.js';

const base: UpdateState = { status: 'idle', autoCheck: true, currentVersion: '0.1.0', version: null, percent: null, lastCheckedAt: null };

beforeEach(() => {
  useUpdateStore.setState({ state: null, dismissed: null });
});

describe('bannerFor (spec §15: "Nova versão X baixada — Reiniciar para atualizar")', () => {
  it('shows nothing until an update is downloaded or rejected', () => {
    expect(bannerFor(null, null)).toBeNull();
    for (const status of ['unsupported', 'disabled', 'idle', 'checking', 'downloading'] as const) {
      expect(bannerFor({ ...base, status, version: '0.1.1' }, null), status).toBeNull();
    }
  });

  it('offers the restart once the verified update is downloaded', () => {
    expect(bannerFor({ ...base, status: 'downloaded', version: '0.1.1' }, null)).toEqual({ kind: 'downloaded', version: '0.1.1' });
  });

  it('tells the person when the signature check rejected a download', () => {
    expect(bannerFor({ ...base, status: 'rejected', version: '0.1.1' }, null)).toEqual({ kind: 'rejected', version: '0.1.1' });
    expect(bannerFor({ ...base, status: 'rejected', version: null }, null)).toEqual({ kind: 'rejected', version: '?' });
  });

  it('keeps a closed banner closed for that version only', () => {
    useUpdateStore.getState().setState({ ...base, status: 'downloaded', version: '0.1.1' });
    useUpdateStore.getState().dismiss();
    const { state, dismissed } = useUpdateStore.getState();
    expect(bannerFor(state, dismissed)).toBeNull();
    expect(bannerFor({ ...base, status: 'downloaded', version: '0.1.2' }, dismissed)).not.toBeNull();
    expect(bannerFor({ ...base, status: 'rejected', version: '0.1.1' }, dismissed)).not.toBeNull();
  });
});

describe('syncUpdates', () => {
  it('loads the state, follows events and stops after unsubscribing', async () => {
    let push: (state: UpdateState) => void = () => {};
    const off = vi.fn();
    const api: UpdatesApi = {
      state: vi.fn(async () => base),
      setAutoCheck: vi.fn(),
      checkNow: vi.fn(),
      notes: vi.fn(),
      restart: vi.fn(),
      onState: vi.fn((cb: (state: UpdateState) => void) => {
        push = cb;
        return off;
      }),
    };
    const stop = syncUpdates(api);
    await Promise.resolve();
    expect(useUpdateStore.getState().state).toEqual(base);
    push({ ...base, status: 'downloaded', version: '0.1.1' });
    expect(useUpdateStore.getState().state?.status).toBe('downloaded');
    stop();
    expect(off).toHaveBeenCalledOnce();
  });

  it('shows nothing when the main process cannot answer', async () => {
    const api: UpdatesApi = {
      state: vi.fn(async () => Promise.reject(new Error('INTERNAL'))),
      setAutoCheck: vi.fn(),
      checkNow: vi.fn(),
      notes: vi.fn(),
      restart: vi.fn(),
      onState: vi.fn(() => () => {}),
    };
    syncUpdates(api)();
    await Promise.resolve();
    expect(useUpdateStore.getState().state).toBeNull();
  });
});

describe('update texts', () => {
  it('match the spec wording in pt-BR and exist in English', () => {
    expect(translate('pt-BR', 'updates.banner.downloaded', { version: '0.1.1' })).toBe('Nova versão 0.1.1 baixada');
    expect(translate('pt-BR', 'updates.banner.restart')).toBe('Reiniciar para atualizar');
    expect(translate('en', 'updates.banner.restart')).toBe('Restart to update');
  });
});
