// The app's registration-key activation (onboarding plan, phase 3): validate the key with the license
// service and, on success, arm the cross-grade from the company download code the service returns —
// without ever letting that secret into the AppLicenseInfo the renderer reads.
import { describe, expect, it, vi } from 'vitest';
import { registrationKeyChecksum } from '@ghostlink/shared';
import { LicenseManager } from '../../src/main/license/manager.js';
import type { LicenseKeyStore } from '../../src/main/license/store.js';

/** A registration key whose checksum is valid, so normalizeRegistrationKey (used by activate) accepts it. */
function validKey(body12 = 'ABCDEFGHJKMN'): string {
  const full = body12 + registrationKeyChecksum(body12); // 12 symbols + the 4-symbol checksum
  return `GLE-${full.slice(0, 4)}-${full.slice(4, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}`;
}

function fakeStore(initial: string | null = null): LicenseKeyStore {
  let key = initial;
  return {
    read: () => key,
    save: (k: string) => {
      key = k;
    },
    clear: () => {
      key = null;
    },
    canEncrypt: () => true,
  } as unknown as LicenseKeyStore;
}

const ok = (body: unknown) => vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve(body) });

describe('LicenseManager cross-grade arming', () => {
  it('arms with the download code a valid key returns, and keeps it out of the license info', async () => {
    const onDownloadCode = vi.fn();
    const code = 'A'.repeat(32);
    const mgr = new LicenseManager({
      store: fakeStore(),
      fetch: ok({ company: 'Acme', maxServers: 3, used: 1, validUntil: 123, downloadCode: code }),
      onDownloadCode,
    });
    const info = await mgr.activate(validKey());
    expect(onDownloadCode).toHaveBeenCalledWith(code);
    expect(info).toEqual({ active: true, company: 'Acme', maxServers: 3, used: 1, validUntil: 123 });
    expect(info).not.toHaveProperty('downloadCode');
  });

  it('re-arms from a stored key on info()', async () => {
    const onDownloadCode = vi.fn();
    const code = 'B'.repeat(32);
    const mgr = new LicenseManager({ store: fakeStore('GLE-STORED-KEY'), fetch: ok({ maxServers: 1, downloadCode: code }), onDownloadCode });
    await mgr.info();
    expect(onDownloadCode).toHaveBeenCalledWith(code);
  });

  it('does not arm when the response has no usable download code', async () => {
    const onDownloadCode = vi.fn();
    await new LicenseManager({ store: fakeStore('k'), fetch: ok({ maxServers: 1 }), onDownloadCode }).info();
    await new LicenseManager({ store: fakeStore('k'), fetch: ok({ maxServers: 1, downloadCode: 'short' }), onDownloadCode }).info();
    expect(onDownloadCode).not.toHaveBeenCalled();
  });
});

describe('LicenseManager.holdsKey (the create-time gate)', () => {
  it('is false with no key stored, true once a key is entered, false after clear', async () => {
    const mgr = new LicenseManager({ store: fakeStore(), fetch: ok({ maxServers: 2 }) });
    expect(mgr.holdsKey()).toBe(false); // no key entered yet
    await mgr.activate(validKey()); // activate stores the key
    expect(mgr.holdsKey()).toBe(true);
    mgr.clear();
    expect(mgr.holdsKey()).toBe(false);
  });

  it('counts a stored key immediately, without needing a live re-check', () => {
    const mgr = new LicenseManager({ store: fakeStore('GLE-STORED-KEY'), fetch: ok({ maxServers: 1 }) });
    expect(mgr.holdsKey()).toBe(true); // the key is there; no info() call required
  });

  it('still counts a stored key when the license service is unreachable (a flaky launch must not drop to normal)', async () => {
    const mgr = new LicenseManager({ store: fakeStore('k'), fetch: vi.fn().mockRejectedValue(new Error('service down')) });
    expect(await mgr.info()).toMatchObject({ active: false }); // validation fails this session
    expect(mgr.holdsKey()).toBe(true); // but the key is still held
  });
});

describe('LicenseManager.serversAvailable (quota at create)', () => {
  it('is true when the key still has room (used < maxServers)', async () => {
    const mgr = new LicenseManager({ store: fakeStore('k'), fetch: ok({ maxServers: 3, used: 1 }) });
    expect(await mgr.serversAvailable()).toBe(true);
  });

  it('is false when the key is at its limit (used >= maxServers)', async () => {
    const mgr = new LicenseManager({ store: fakeStore('k'), fetch: ok({ maxServers: 2, used: 2 }) });
    expect(await mgr.serversAvailable()).toBe(false);
  });

  it('fails open: true with no key, and true when the service is unreachable', async () => {
    expect(await new LicenseManager({ store: fakeStore(), fetch: ok({ maxServers: 1, used: 9 }) }).serversAvailable()).toBe(true);
    expect(await new LicenseManager({ store: fakeStore('k'), fetch: vi.fn().mockRejectedValue(new Error('down')) }).serversAvailable()).toBe(true);
  });
});
