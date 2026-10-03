import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type EnterpriseLicenseInfo, type HermesState } from '@ghostlink/shared';
import { settingsTabs } from '../../src/renderer/features/server-settings/access.js';
import { licenseBanner } from '../../src/renderer/features/enterprise/enterpriseModel.js';
import { enterpriseReducer, initialEnterprise } from '../../src/renderer/stores/enterprise.js';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';

const DAY = 86_400_000;
const info = (o: Partial<EnterpriseLicenseInfo> = {}): EnterpriseLicenseInfo => ({ state: 'valid', company: 'TC Flag', issuedAt: 0, expiresAt: 30 * DAY, graceEndsAt: 37 * DAY, ...o });
const welcome = (extra: Record<string, unknown>) => ({ serverId: 's1', ...extra }) as unknown as RendererWelcome;
const hermes = { botId: 'b'.repeat(32), connected: true, locked: false, keys: { deepseek: null, openrouter: null }, settings: { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null }, disabledSkills: null, access: { roleIds: [], channels: 'all' } }, version: 0, report: null, reportAt: null } satisfies HermesState;

describe('the enterprise store (spec §1, §2)', () => {
  it('starts from the welcome and follows the events of its own server only', () => {
    let s = enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({ enterprise: { edition: 'enterprise', license: info() }, hermes }) });
    expect(s).toMatchObject({ serverId: 's1', edition: 'enterprise', license: { company: 'TC Flag' }, hermes: { connected: true } });
    s = enterpriseReducer(s, { type: 'event', serverId: 's2', envelope: { t: 'enterprise.state', d: { edition: 'normal' } } });
    expect(s.edition).toBe('enterprise');
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'enterprise.state', d: { edition: 'normal' } } });
    expect(s).toMatchObject({ edition: 'normal', license: { company: 'TC Flag' } });
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'hermes.state', d: { ...hermes, connected: false } } });
    expect(s.hermes?.connected).toBe(false);
    expect(enterpriseReducer(s, { type: 'left' })).toEqual(initialEnterprise);
  });

  it('a server before 0.6.0 is normal', () => {
    expect(enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({}) })).toMatchObject({ edition: 'normal', license: null, hermes: null });
  });

  it('warns the owner in the 7 days before expiry and the 7 after (spec §1 "Validade")', () => {
    expect(licenseBanner(info({ state: 'expiring' }), true)).toEqual({ key: 'enterprise.banner.expiring', date: 30 * DAY });
    expect(licenseBanner(info({ state: 'grace' }), true)).toEqual({ key: 'enterprise.banner.grace', date: 37 * DAY });
    expect(licenseBanner(info({ state: 'expiring' }), false)).toBeNull();
    expect(licenseBanner(info(), true)).toBeNull();
    expect(licenseBanner(null, true)).toBeNull();
  });

  it('the Enterprise tab is the owner\'s, on servers that know editions', () => {
    expect(settingsTabs(ALL_PERMISSIONS, true, { enterprise: true })).toContain('enterprise');
    expect(settingsTabs(ALL_PERMISSIONS, false, { enterprise: true })).not.toContain('enterprise');
    expect(settingsTabs(ALL_PERMISSIONS, true)).not.toContain('enterprise');
  });

  it('ignores an answer that belongs to another server', () => {
    const s = enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({ enterprise: { edition: 'enterprise', license: info() }, hermes }) });
    expect(enterpriseReducer(s, { type: 'enterprise', serverId: 's2', state: { edition: 'normal' } })).toBe(s);
    expect(enterpriseReducer(s, { type: 'hermes', serverId: 's2', state: { ...hermes, connected: false } })).toBe(s);
    expect(enterpriseReducer(s, { type: 'hermes', serverId: 's1', state: { ...hermes, connected: false } }).hermes?.connected).toBe(false);
  });
});
