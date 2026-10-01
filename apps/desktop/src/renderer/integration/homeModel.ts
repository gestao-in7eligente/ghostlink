import type { HostAddressKind, HostState, HostStatus } from '../../shared/hostTypes.js';
import type { SavedServer } from '../../shared/ipcTypes.js';

export interface HomeServerRow {
  id: string;
  name: string;
  /** The first saved address (host:port), the row's second line. */
  address: string | null;
  /** This app hosts that server (same serverKeyId as the Host mode's). */
  hosted: boolean;
  /** Hosted here but not running: connecting cannot work, it has to be started first. */
  stopped: boolean;
}

/**
 * The Home screen's server list: saved servers, the one hosted here marked by its key only
 * (leave/delete spec §6). Never by name: a Railway server may share the name of an old local
 * one. The Host mode knows the key whenever the last hosted server's data dir exists.
 */
export function homeServerRows(servers: readonly SavedServer[], host: HostStatus | null): HomeServerRow[] {
  const hostedKey = host?.serverKeyId ?? null;
  const running = host?.state === 'running';
  return servers.map((s) => {
    const hosted = hostedKey !== null && s.serverKeyId === hostedKey;
    return { id: s.id, name: s.name, address: s.addresses[0] ?? null, hosted, stopped: hosted && !running };
  });
}

/**
 * Opening this saved server from the rail should start it instead of connecting:
 * it is hosted here and not running (a connect could only fail).
 */
export function shouldStartInsteadOfConnect(server: SavedServer, host: HostStatus | null): boolean {
  return homeServerRows([server], host)[0]?.stopped === true;
}

/**
 * The hosted server to offer "Iniciar <nome>" for: the last Host mode config when
 * the server is not running (HostStatus.config keeps the last settings used).
 */
export function stoppedHostedServer(host: HostStatus | null): { name: string } | null {
  if (!host || !host.config) return null;
  if (host.state === 'running' || host.state === 'starting') return null;
  return { name: host.config.name };
}

export interface HomeActivity {
  name: string;
  state: HostState;
  /** Online members, only while running. */
  members: number | null;
  maxMembers: number | null;
  /** The address to share, best reach first; null while not running. */
  address: string | null;
}

/** Reach order for the address shown in "Ativo agora": never loopback (this computer only). */
const SHARE_ORDER: readonly HostAddressKind[] = ['public', 'radmin', 'tailscale', 'zerotier', 'virtual', 'lan'];

/** "Ativo agora": the server hosted here (running, starting, stopped or failed), or null. */
export function homeActivity(host: HostStatus | null): HomeActivity | null {
  if (!host || !host.config) return null;
  const running = host.state === 'running';
  const shared = running ? SHARE_ORDER.map((kind) => host.addresses.find((a) => a.kind === kind)).find((a) => a !== undefined) : undefined;
  return {
    name: host.config.name,
    state: host.state,
    members: running ? host.members : null,
    maxMembers: host.maxMembers ?? host.config.maxMembers,
    address: shared?.address ?? null,
  };
}
