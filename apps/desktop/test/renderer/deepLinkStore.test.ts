import { beforeEach, describe, expect, it } from 'vitest';
import { formatFingerprint, toBase64Url, type ParsedJoinInput } from '@ghostlink/shared';
import { joinStartFromLink, useDeepLinkStore } from '../../src/renderer/features/deeplink/deepLinkStore.js';

const KEY = toBase64Url(new Uint8Array(32).fill(9));
const invite = (name: string): ParsedJoinInput => ({ kind: 'invite', invite: { addresses: ['203.0.113.7:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name } });

beforeEach(() => useDeepLinkStore.getState().clear());

describe('deep links in the page (spec §12)', () => {
  it('shows the first link and ignores new ones while its dialog is open', () => {
    const { offer } = useDeepLinkStore.getState();
    expect(offer(invite('Casa'))).toBe(true);
    expect(offer(invite('Outra'))).toBe(false);
    expect(useDeepLinkStore.getState().pending?.name).toBe('Casa');
    useDeepLinkStore.getState().clear();
    expect(offer(invite('Outra'))).toBe(true);
  });

  it('never offers a bare address (a link must be an invite)', () => {
    expect(useDeepLinkStore.getState().offer({ kind: 'address', address: '1.2.3.4:7700' })).toBe(false);
  });

  it('starts the Join flow at the invite confirmation: the name is only a hint, nothing connects yet', () => {
    const link = invite('Casa');
    if (link.kind !== 'invite') throw new Error('expected an invite');
    const start = joinStartFromLink('Ana', link.invite);
    expect(start).toMatchObject({
      step: 'confirm',
      source: 'invite',
      fingerprint: formatFingerprint(KEY),
      nickname: 'Ana',
      target: { addresses: ['203.0.113.7:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa' },
    });
  });
});
