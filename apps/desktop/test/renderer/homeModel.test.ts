import { describe, expect, it } from 'vitest';
import type { HostStatus } from '../../src/shared/hostTypes.js';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import { filterHomeRows, homeActivity, homeServerRows, shouldStartInsteadOfConnect, stoppedHostedServer } from '../../src/renderer/integration/homeModel.js';

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
      { id: 'a', name: 'Casa', address: '127.0.0.1:7700', hosted: false, stopped: false },
      { id: 'b', name: 'Amigos', address: '127.0.0.1:7700', hosted: false, stopped: false },
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

describe('Home list filters (tabs and search)', () => {
  const rows = homeServerRows(
    [saved('a', 'Casa do Zé', 'KEY-A'), { ...saved('b', 'Amigos', 'KEY-B'), addresses: ['altaria.proxy.rlwy.net:25889'] }, { ...saved('c', 'Sem endereço', 'KEY-C'), addresses: [] }],
    host({ state: 'running', serverKeyId: 'KEY-A', config }),
  );

  it('shows everything on "Todos" and only the server hosted here on "Hospedados"', () => {
    expect(filterHomeRows(rows, 'all', '').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterHomeRows(rows, 'hosted', '').map((r) => r.id)).toEqual(['a']);
  });

  it('searches names and addresses, ignoring case, accents and surrounding spaces', () => {
    expect(filterHomeRows(rows, 'all', '  casa do ze ').map((r) => r.id)).toEqual(['a']);
    expect(filterHomeRows(rows, 'all', 'RLWY').map((r) => r.id)).toEqual(['b']);
    expect(filterHomeRows(rows, 'all', 'nada')).toEqual([]);
  });

  it('keeps a row without an address', () => {
    expect(rows[2]!.address).toBeNull();
  });
});

describe('"Ativo agora" (the server hosted here)', () => {
  it('is empty without a hosted server', () => {
    expect(homeActivity(null)).toBeNull();
    expect(homeActivity(host({ state: 'stopped', config: null }))).toBeNull();
  });

  it('shows the running server with its members and the address to share', () => {
    const status = host({
      state: 'running',
      config,
      members: 3,
      maxMembers: 100,
      addresses: [
        { address: '127.0.0.1:7700', kind: 'loopback' },
        { address: '192.168.0.10:7700', kind: 'lan' },
        { address: '203.0.113.7:7700', kind: 'public' },
      ],
    });
    expect(homeActivity(status)).toEqual({ name: 'Casa', state: 'running', members: 3, maxMembers: 100, address: '203.0.113.7:7700' });
  });

  it('falls back to a LAN address, and shows a stopped or failed server without members', () => {
    expect(homeActivity(host({ state: 'running', config, addresses: [{ address: '192.168.0.10:7700', kind: 'lan' }] }))?.address).toBe('192.168.0.10:7700');
    expect(homeActivity(host({ state: 'failed', config, members: 2 }))).toEqual({ name: 'Casa', state: 'failed', members: null, maxMembers: 100, address: null });
  });
});
