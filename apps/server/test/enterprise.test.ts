import { describe, expect, it } from 'vitest';
import { FEATURE_ENTERPRISE, type EnterpriseState } from '@ghostlink/shared';
import { createEnterpriseModule } from '../src/enterprise/index.js';
import { withDb } from './helpers/db.js';
import { testLicenseKey } from './helpers/license.js';
import { textFixture } from './text/helpers.js';

const DAY = 86_400_000;

async function setup() {
  const key = testLicenseKey();
  const enterprise = createEnterpriseModule({ publicKey: key.publicKey });
  const fx = await textFixture({ extraModules: [enterprise] });
  const serverKeyId = fx.t.server.serverKeyId;
  const license = (o: { days?: number; serverKeyId?: string; issuedDaysAgo?: number } = {}) =>
    key.issue({
      company: 'TC Flag',
      serverKeyId: o.serverKeyId ?? serverKeyId,
      issuedAt: fx.clock.now - (o.issuedDaysAgo ?? 0) * DAY,
      expiresAt: fx.clock.now + (o.days ?? 365) * DAY,
    });
  return { fx, enterprise, license };
}

describe('Enterprise: the license and the edition (spec §1)', () => {
  it('a valid license makes the server Enterprise for everyone; only the owner sees the license', async () => {
    const { fx, license } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    expect((fx.owner.welcome as { features: string[] }).features).toContain(FEATURE_ENTERPRISE);
    expect(fx.owner.welcome.enterprise).toEqual({ edition: 'normal', license: null });
    expect(ana.welcome.enterprise).toEqual({ edition: 'normal' });

    expect(await ana.fail('enterprise.license.set', { license: license() })).toBe('FORBIDDEN');
    const state = await fx.owner.ok<EnterpriseState>('enterprise.license.set', { license: license() });
    expect(state).toMatchObject({ edition: 'enterprise', license: { state: 'valid', company: 'TC Flag' } });
    expect(await ana.event<EnterpriseState>('enterprise.state')).toEqual({ edition: 'enterprise' });
    // The bot handshake reads the edition from the database.
    expect(withDb(fx.t.dataDir, (db) => db.get<{ edition: string }>('SELECT edition FROM enterprise WHERE id = 1')?.edition)).toBe('enterprise');
  });

  it('refuses a broken, forged or other-server license, and one past its grace', async () => {
    const { fx, license } = await setup();
    expect(await fx.owner.fail('enterprise.license.set', { license: 'GLE1.abc.def' })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: testLicenseKey().issue({ company: 'X', serverKeyId: fx.t.server.serverKeyId, issuedAt: 0, expiresAt: fx.clock.now + DAY }) })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: license({ serverKeyId: 'T'.repeat(43) }) })).toBe('LICENSE_INVALID');
    expect(await fx.owner.fail('enterprise.license.set', { license: license({ issuedDaysAgo: 400, days: -8 }) })).toBe('LICENSE_EXPIRED');
    expect(fx.owner.seen('enterprise.state')).toEqual([]);
  });

  it('warns 7 days before, stays Enterprise 7 days after, then is normal; a renewal counts at once', async () => {
    const { fx, enterprise, license } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    await fx.owner.ok('enterprise.license.set', { license: license({ days: 10 }) });
    await ana.event('enterprise.state');
    ana.clear();
    fx.owner.clear();

    fx.clock.now += 4 * DAY;
    enterprise.recheck();
    expect(await fx.owner.event<EnterpriseState>('enterprise.state')).toMatchObject({ edition: 'enterprise', license: { state: 'expiring' } });
    fx.clock.now += 7 * DAY;
    enterprise.recheck();
    expect(await fx.owner.event<EnterpriseState>('enterprise.state', (d) => d.license?.state === 'grace')).toMatchObject({ edition: 'enterprise' });
    await ana.sync();
    expect(ana.seen('enterprise.state')).toEqual([]);

    fx.clock.now += 7 * DAY;
    enterprise.recheck();
    expect(await ana.event<EnterpriseState>('enterprise.state')).toEqual({ edition: 'normal' });
    expect(enterprise.edition).toBe('normal');

    const renewed = await fx.owner.ok<EnterpriseState>('enterprise.license.set', { license: license({ days: 365 }) });
    expect(renewed).toMatchObject({ edition: 'enterprise', license: { state: 'valid' } });
    expect(await ana.event<EnterpriseState>('enterprise.state', (d) => d.edition === 'enterprise')).toEqual({ edition: 'enterprise' });
  });
});
