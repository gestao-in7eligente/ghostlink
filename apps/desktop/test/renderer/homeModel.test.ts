import { describe, expect, it } from 'vitest';
import type { HostStatus } from '../../src/shared/hostTypes.js';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import { homeServerRows, shouldStartInsteadOfConnect, stoppedHostedServer } from '../../src/renderer/integration/homeModel.js';

const saved = (id: string, name: string, serverKeyId: string): SavedServer => ({ id, name, serverKeyId, addresses: ['127.0.0.1:7700'], nickname: 'Ana', addedAt: 1 });

function host(partial: Partial<HostStatus>): HostStatus {
  return {
    revision: 1,
    state: 'stopped',
    config: null,
    port: null,
    serverKeyId: null,
    fingerprint: null,
    addresses: [],
    members: null,
    maxMembers: null,
    hasOwner: null,
    error: null,
    errorPort: null,
    suggestedPort: null,
    joinError: null,
    invite: null,
    startedAt: null,
    network: null,
    ...partial,
  } as HostStatus;
}

const config = { name: 'Casa', port: 7700, joinMode: 'invite' as const, maxMembers: 100 };

describe('Home screen server list', () => {
  const servers = [saved('a', 'Casa', 'KEY-A'), saved('b', 'Amigos', 'KEY-B')];

  it('lists saved servers without a host', () => {
    expect(homeServerRows(servers, null)).toEqual([
      { id: 'a', name: 'Casa', hosted: false, stopped: false },
      { id: 'b', name: 'Amigos', hosted: false, stopped: false },
    ]);
  });

  it('marks the running hosted server by its key', () => {
    const rows = homeServerRows(servers, host({ state: 'running', serverKeyId: 'KEY-A', config }));
    expect(rows[0]).toMatchObject({ hosted: true, stopped: false });
    expect(rows[1]).toMatchObject({ hosted: false, stopped: false });
  });

  it('marks the hosted server as stopped when it is not running', () => {
    const rows = homeServerRows(servers, host({ state: 'stopped', serverKeyId: 'KEY-A', config }));
    expect(rows[0]).toMatchObject({ hosted: true, stopped: true });
  });

  it('falls back to the last hosted name when the key is not known yet (fresh start)', () => {
    const rows = homeServerRows(servers, host({ state: 'stopped', serverKeyId: null, config }));
    expect(rows.map((r) => r.hosted)).toEqual([true, false]);
  });

  it('never marks a server with a different key even if the name matches', () => {
    const rows = homeServerRows([saved('c', 'Casa', 'OTHER')], host({ state: 'running', serverKeyId: 'KEY-A', config }));
    expect(rows[0]!.hosted).toBe(false);
  });
});

describe('"Iniciar <nome>" offer', () => {
  it('is offered for the last hosted config while stopped or failed', () => {
    expect(stoppedHostedServer(host({ state: 'stopped', config }))).toEqual({ name: 'Casa' });
    expect(stoppedHostedServer(host({ state: 'failed', config }))).toEqual({ name: 'Casa' });
  });

  it('is not offered while running or starting, or without a previous config', () => {
    expect(stoppedHostedServer(host({ state: 'running', config }))).toBeNull();
    expect(stoppedHostedServer(host({ state: 'starting', config }))).toBeNull();
    expect(stoppedHostedServer(host({ state: 'stopped', config: null }))).toBeNull();
    expect(stoppedHostedServer(null)).toBeNull();
  });
});

describe('rail click on a saved server', () => {
  const casa = saved('a', 'Casa', 'KEY-A');

  it('starts the server hosted here when it is stopped', () => {
    expect(shouldStartInsteadOfConnect(casa, host({ state: 'stopped', serverKeyId: 'KEY-A', config }))).toBe(true);
    expect(shouldStartInsteadOfConnect(casa, host({ state: 'failed', serverKeyId: null, config }))).toBe(true);
  });

  it('connects normally when it is running or not hosted here', () => {
    expect(shouldStartInsteadOfConnect(casa, host({ state: 'running', serverKeyId: 'KEY-A', config }))).toBe(false);
    expect(shouldStartInsteadOfConnect(saved('b', 'Amigos', 'KEY-B'), host({ state: 'stopped', serverKeyId: 'KEY-A', config }))).toBe(false);
    expect(shouldStartInsteadOfConnect(casa, null)).toBe(false);
  });
});
