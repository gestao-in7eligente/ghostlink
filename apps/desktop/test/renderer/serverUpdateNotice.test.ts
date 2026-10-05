import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_URL } from '@ghostlink/shared';
import type { ManagedServerUpdate, ServerUpdateState } from '../../src/shared/serverUpdateTypes.js';
import { noticeKey, ownerUpdateNotice, serverUpdateDocsUrl, type OwnerNoticeInput } from '../../src/renderer/features/serverUpdate/serverUpdateModel.js';
import { managedFor, syncServerUpdate, useServerUpdateStore } from '../../src/renderer/features/serverUpdate/serverUpdateStore.js';
import { translate } from '../../src/renderer/i18n/index.js';

const KEY_ID = 'k'.repeat(43);
const managed = (state: ServerUpdateState, version: string | null = '0.2.0'): ManagedServerUpdate => ({ serverKeyId: KEY_ID, version, target: '0.2.2', state });
const owner: OwnerNoticeInput = { isOwner: true, serverVersion: '0.2.0', appVersion: '0.2.2', managed: null };

describe('ownerUpdateNotice (spec 2026-10-01 §5)', () => {
  it('a member who is not the owner never sees it', () => {
    expect(ownerUpdateNotice({ ...owner, isOwner: false })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, isOwner: false, managed: managed('waiting') })).toBeNull();
  });

  it('the owner of a server on the app’s version, or a newer one, sees nothing', () => {
    expect(ownerUpdateNotice({ ...owner, serverVersion: '0.2.2' })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, serverVersion: '0.3.0' })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, serverVersion: '0.2.10', appVersion: '0.2.9' })).toBeNull();
  });

  it('compares versions as numbers (0.2.9 is older than 0.2.10)', () => {
    expect(ownerUpdateNotice({ ...owner, serverVersion: '0.2.9', appVersion: '0.2.10' })).toEqual({ kind: 'manual', version: '0.2.9', target: '0.2.10' });
  });

  it('a server the app did not create shows how to update it', () => {
    expect(ownerUpdateNotice(owner)).toEqual({ kind: 'manual', version: '0.2.0', target: '0.2.2' });
  });

  it('a Railway server the app created says it updates by itself, and follows main’s state', () => {
    expect(ownerUpdateNotice({ ...owner, managed: managed('unknown', null) })).toEqual({ kind: 'managed', version: '0.2.0', target: '0.2.2', state: 'waiting' });
    for (const state of ['waiting', 'updating', 'failed', 'railwayDisconnected'] as const) {
      expect(ownerUpdateNotice({ ...owner, managed: managed(state) }), state).toEqual({ kind: 'managed', version: '0.2.0', target: '0.2.2', state });
    }
  });

  it('a managed server main just updated shows nothing while the reconnect brings the new welcome', () => {
    expect(ownerUpdateNotice({ ...owner, managed: managed('current', '0.2.2') })).toBeNull();
  });

  it('waits for the app version and for main’s answer, and ignores what is not a release', () => {
    expect(ownerUpdateNotice({ ...owner, appVersion: null })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, managed: undefined })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, serverVersion: '' })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, serverVersion: '0.2.0-dev' })).toBeNull();
    expect(ownerUpdateNotice({ ...owner, appVersion: '0.2.2-rc.1' })).toBeNull();
  });

  it('a closed band comes back only when what it says changes', () => {
    const waiting = ownerUpdateNotice({ ...owner, managed: managed('waiting') })!;
    const failed = ownerUpdateNotice({ ...owner, managed: managed('failed') })!;
    const manual = ownerUpdateNotice(owner)!;
    expect(noticeKey(KEY_ID, waiting)).toBe(noticeKey(KEY_ID, { ...waiting }));
    expect(new Set([noticeKey(KEY_ID, waiting), noticeKey(KEY_ID, failed), noticeKey(KEY_ID, manual), noticeKey('x'.repeat(43), waiting)]).size).toBe(4);
  });

  it('"veja como" opens the site in the app’s language', () => {
    expect(serverUpdateDocsUrl('pt-BR')).toBe(`${SITE_URL}hospedar-em-vps#atualizar`);
    expect(serverUpdateDocsUrl('en')).toBe(`${SITE_URL}en/host-on-vps#update`);
  });

  it('the texts carry both versions in both languages', () => {
    for (const locale of ['pt-BR', 'en'] as const) {
      for (const key of ['serverUpdate.waiting', 'serverUpdate.failed', 'serverUpdate.railwayDisconnected', 'serverUpdate.manual'] as const) {
        const text = translate(locale, key, { version: '0.2.0', target: '0.2.2' });
        expect(text, `${locale} ${key}`).toContain('0.2.0');
        expect(text, `${locale} ${key}`).toContain('0.2.2');
      }
    }
    expect(translate('pt-BR', 'serverUpdate.waiting', { version: '0.2.0', target: '0.2.2' })).toBe(
      'Este servidor está na 0.2.0. Ele será atualizado para a 0.2.2 quando ninguém estiver em chamada.',
    );
    expect(translate('pt-BR', 'serverUpdate.confirm.body')).toBe('Quem estiver em chamada cai por alguns segundos.');
  });
});

describe('syncServerUpdate', () => {
  beforeEach(() => {
    useServerUpdateStore.setState({ appVersion: null, managed: {}, dismissed: [] });
  });

  it('loads the app version and the server’s state, then follows main’s events', async () => {
    let listener: ((u: ManagedServerUpdate) => void) | null = null;
    const off = vi.fn();
    const api = {
      app: { info: vi.fn(async () => ({ version: '0.2.2', platform: 'win32' as const, locale: 'pt-BR' })), openExternal: vi.fn(), copyText: vi.fn(), showWindow: vi.fn() },
      serverUpdates: {
        state: vi.fn(async () => managed('waiting')),
        updateNow: vi.fn(),
        onState: vi.fn((cb: (u: ManagedServerUpdate) => void) => {
          listener = cb;
          return off;
        }),
      },
    };
    const stop = syncServerUpdate(api, KEY_ID);
    await vi.waitFor(() => expect(managedFor(useServerUpdateStore.getState().managed, KEY_ID)?.state).toBe('waiting'));
    expect(useServerUpdateStore.getState().appVersion).toBe('0.2.2');
    expect(api.serverUpdates.state).toHaveBeenCalledWith(KEY_ID);
    listener!(managed('updating'));
    expect(managedFor(useServerUpdateStore.getState().managed, KEY_ID)?.state).toBe('updating');
    stop();
    expect(off).toHaveBeenCalled();
  });

  it('a server main does not manage is null, and an unknown one stays undefined', async () => {
    const api = {
      app: { info: async () => ({ version: '0.2.2', platform: 'win32' as const, locale: 'pt-BR' }), openExternal: vi.fn(), copyText: vi.fn(), showWindow: vi.fn() },
      serverUpdates: { state: vi.fn(async () => null), updateNow: vi.fn(), onState: () => () => {} },
    };
    syncServerUpdate(api, KEY_ID);
    await vi.waitFor(() => expect(managedFor(useServerUpdateStore.getState().managed, KEY_ID)).toBeNull());
    expect(managedFor(useServerUpdateStore.getState().managed, 'z'.repeat(43))).toBeUndefined();
  });
});
