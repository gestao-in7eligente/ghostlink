import type { HostStatus } from '../../shared/hostTypes.js';
import type { SavedServer } from '../../shared/ipcTypes.js';

export interface HomeServerRow {
  id: string;
  name: string;
  /** This app hosts that server (same serverKeyId as the Host mode's). */
  hosted: boolean;
  /** Hosted here but not running: connecting cannot work, it has to be started first. */
  stopped: boolean;
}

/** The Home screen's server list: saved servers, the one hosted here marked. */
export function homeServerRows(servers: readonly SavedServer[], host: HostStatus | null): HomeServerRow[] {
  const hostedKey = host?.serverKeyId ?? null;
  const hostedName = host?.config?.name ?? null;
  const running = host?.state === 'running';
  return servers.map((s) => {
    // While stopped the Host mode may not know its key yet (fresh app start): fall back to the last hosted name.
    const hosted = hostedKey !== null ? s.serverKeyId === hostedKey : hostedName !== null && s.name === hostedName;
    return { id: s.id, name: s.name, hosted, stopped: hosted && !running };
  });
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
