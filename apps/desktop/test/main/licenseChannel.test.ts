// The update channel the app forms from a registration key (onboarding plan, phase 3):
// one remembered `<service>/updates/<code>/` URL, in <userData>/license-channel.json, feeding the same one-time
// cross-grade a server's advertised channel drives. Nothing here names an edition.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LICENSE_CHANNEL_FILE, LicenseChannelStore, licenseChannelUrl } from '../../src/main/updater/licenseChannel.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('gl-license-channel-');
const CODE_A = 'A'.repeat(32);
const CODE_B = 'B'.repeat(32);
const SERVICE = 'https://licencas-production-d8fc.up.railway.app';

let clock: number;
const file = () => join(dir.path, LICENSE_CHANNEL_FILE);
const load = () => LicenseChannelStore.load(dir.path, { now: () => clock });

beforeEach(() => {
  clock = 1_000_000;
});

describe('licenseChannelUrl', () => {
  it('forms the company feed URL from a download code', () => {
    expect(licenseChannelUrl(CODE_A)).toBe(`${SERVICE}/updates/${CODE_A}/`);
    expect(licenseChannelUrl(CODE_A, 'https://x.example/')).toBe(`https://x.example/updates/${CODE_A}/`);
  });
});

describe('LicenseChannelStore', () => {
  it('starts empty', () => {
    expect(load().latest()).toBeNull();
  });

  it('remembers the channel a valid code forms, and reads it back across restarts', () => {
    const store = load();
    expect(store.set(CODE_A)).toBe(true); // first URL: changed
    expect(store.latest()).toEqual({ url: licenseChannelUrl(CODE_A), seenAt: 1_000_000 });
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(load().latest()).toEqual({ url: licenseChannelUrl(CODE_A), seenAt: 1_000_000 });
  });

  it('reports no change for the same code, a change for a new one', () => {
    const store = load();
    store.set(CODE_A);
    clock += 5;
    expect(store.set(CODE_A)).toBe(false); // same URL
    expect(store.latest()?.seenAt).toBe(1_000_005); // the time still moves
    expect(store.set(CODE_B)).toBe(true); // a different URL
    expect(store.latest()?.url).toBe(licenseChannelUrl(CODE_B));
  });

  it('ignores anything that is not a download code', () => {
    const store = load();
    expect(store.set('too-short')).toBe(false);
    expect(store.set('x'.repeat(33))).toBe(false);
    expect(store.set('bad chars!!!!!!!!!!!!!!!!!!!!!!!')).toBe(false);
    expect(store.latest()).toBeNull();
  });
});
