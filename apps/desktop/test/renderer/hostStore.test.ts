import { describe, expect, it } from 'vitest';
import type { HostConfig, HostStatus } from '../../src/shared/hostTypes.js';
import { initialHostForm, inviteOptions, validateHostForm, type HostForm } from '../../src/renderer/features/host/hostFormModel.js';
import { hostIndicator, hostReducer, initialHost, isHostedHere } from '../../src/renderer/features/host/hostStore.js';

const CONFIG: HostConfig = { name: 'Casa do Zé', port: 7700, joinMode: 'invite', maxMembers: 100 };
const KEY = 'k'.repeat(43);

function status(patch: Partial<HostStatus> = {}): HostStatus {
  return {
    revision: 1,
    state: 'running',
    config: CONFIG,
    port: 7700,
    serverKeyId: KEY,
    fingerprint: 'AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD',
    addresses: [{ address: '127.0.0.1:7700', kind: 'loopback' }],
    members: 1,
    maxMembers: 100,
    hasOwner: true,
    error: null,
    errorPort: null,
    joinError: null,
    invite: null,
    startedAt: 1,
    ...patch,
  };
}

describe('hostReducer', () => {
  it('takes the first status and every newer one', () => {
    const a = hostReducer(initialHost, { type: 'status', status: status({ revision: 3 }) });
    expect(a.status?.revision).toBe(3);
    const b = hostReducer(a, { type: 'status', status: status({ revision: 4, state: 'stopping' }) });
    expect(b.status?.state).toBe('stopping');
  });

  it('drops a snapshot older than the one shown (events and replies can cross)', () => {
    const shown = hostReducer(initialHost, { type: 'status', status: status({ revision: 5, state: 'stopped' }) });
    expect(hostReducer(shown, { type: 'status', status: status({ revision: 4, state: 'running' }) })).toBe(shown);
    // The same revision (a plain status() answer) is accepted.
    expect(hostReducer(shown, { type: 'status', status: status({ revision: 5, members: 2, state: 'stopped' }) }).status?.members).toBe(2);
  });

  it('replaces the logs', () => {
    const s = hostReducer(initialHost, { type: 'logs', lines: ['a', 'b'] });
    expect(hostReducer(s, { type: 'logs', lines: ['c'] }).logs).toEqual(['c']);
  });
});

describe('hostIndicator / isHostedHere', () => {
  it('shows nothing when nothing is hosted', () => {
    expect(hostIndicator(null)).toBeNull();
    expect(hostIndicator(status({ state: 'stopped' }))).toBeNull();
    expect(hostIndicator(status({ config: null }))).toBeNull();
  });

  it.each(['starting', 'running', 'stopping', 'failed'] as const)('shows %s with the server name', (state) => {
    expect(hostIndicator(status({ state }))).toEqual({ kind: state, name: 'Casa do Zé' });
  });

  it('marks only the server hosted right now', () => {
    expect(isHostedHere(status(), KEY)).toBe(true);
    expect(isHostedHere(status(), 'x'.repeat(43))).toBe(false);
    expect(isHostedHere(status({ state: 'stopped' }), KEY)).toBe(false);
    expect(isHostedHere(null, KEY)).toBe(false);
  });
});

describe('host form', () => {
  const valid: HostForm = { name: 'Casa do Zé', port: '7700', joinMode: 'invite', maxMembers: '100' };

  it('starts from the defaults (port 7700, invite only, 100 members) or the last server', () => {
    expect(initialHostForm(null, 'Servidor de Ana')).toEqual({ name: 'Servidor de Ana', port: '7700', joinMode: 'invite', maxMembers: '100' });
    expect(initialHostForm({ ...CONFIG, port: 7710, joinMode: 'open', maxMembers: 12 }, 'x')).toEqual({
      name: 'Casa do Zé',
      port: '7710',
      joinMode: 'open',
      maxMembers: '12',
    });
    expect(initialHostForm(null, 'n'.repeat(100)).name).toHaveLength(64);
  });

  it('turns a valid form into a config (trimmed name, numbers)', () => {
    expect(validateHostForm({ ...valid, name: '  Casa  ', port: ' 7710 ' })).toEqual({
      ok: true,
      config: { name: 'Casa', port: 7710, joinMode: 'invite', maxMembers: 100 },
    });
  });

  it.each<[string, Partial<HostForm>, string]>([
    ['an empty name', { name: '   ' }, 'name'],
    ['a long name', { name: 'n'.repeat(65) }, 'name'],
    ['a privileged port', { port: '80' }, 'port'],
    ['a port too big', { port: '65536' }, 'port'],
    ['a port with letters', { port: '77a0' }, 'port'],
    ['a negative port', { port: '-7700' }, 'port'],
    ['a fractional port', { port: '7700.5' }, 'port'],
    ['zero members', { maxMembers: '0' }, 'maxMembers'],
    ['too many members', { maxMembers: '10001' }, 'maxMembers'],
    ['scientific notation', { maxMembers: '1e3' }, 'maxMembers'],
  ])('points at the field for %s', (_label, patch, field) => {
    expect(validateHostForm({ ...valid, ...patch })).toEqual({ ok: false, field });
  });

  it('maps the invite choices to options', () => {
    expect(inviteOptions('168', 'unlimited')).toEqual({ expiresInHours: 168 });
    expect(inviteOptions('never', '1')).toEqual({ maxUses: 1 });
    expect(inviteOptions('24', '10')).toEqual({ expiresInHours: 24, maxUses: 10 });
  });
});
