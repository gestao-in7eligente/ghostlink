// What the Host panel's "Rede" card says (spec §8.5), as pure data for testing.
import type { FirewallStatus, HostNetwork } from '../../../shared/hostTypes.js';
import type { MessageKey, Vars } from '../../i18n/index.js';

export type Tone = 'ok' | 'info' | 'warning' | 'error';

export interface NetworkLine {
  tone: Tone;
  key: MessageKey;
  vars?: Vars;
}

/** The UPnP / reachability lines, most important first. */
export function networkLines(network: HostNetwork | null, port: number | null, busyMediaPorts: readonly string[]): NetworkLine[] {
  const lines: NetworkLine[] = [];
  if (network) {
    const { upnp } = network;
    if (network.cgnat && upnp.wanIp) lines.push({ tone: 'warning', key: 'host.net.cgnat', vars: { ip: upnp.wanIp } });
    const failed = upnp.mappings.filter((m) => !m.ok).map((m) => `${m.protocol} ${m.port}`);
    switch (upnp.state) {
      case 'mapped':
        lines.push({ tone: 'ok', key: 'host.net.upnp.mapped' });
        break;
      case 'partial':
        lines.push({ tone: 'warning', key: 'host.net.upnp.partial', vars: { ports: failed.join(', ') } });
        break;
      case 'searching':
        lines.push({ tone: 'info', key: 'host.net.upnp.searching' });
        break;
      case 'failed':
        lines.push({ tone: 'warning', key: 'host.net.upnp.failed' });
        break;
      case 'unavailable':
        lines.push({ tone: 'warning', key: 'host.net.upnp.unavailable' });
        break;
      case 'off':
        lines.push({ tone: 'info', key: 'host.net.upnp.off' });
        break;
    }
    if (upnp.wanIp && !network.cgnat) lines.push({ tone: 'info', key: 'host.net.wan', vars: { ip: upnp.wanIp } });
    // Manual port forwarding when UPnP could not do it (and it would help: not behind CGNAT).
    if (!network.cgnat && ['partial', 'failed', 'unavailable'].includes(upnp.state) && port !== null) {
      lines.push(network.lanIp ? { tone: 'info', key: 'host.net.forward', vars: { port, lanIp: network.lanIp } } : { tone: 'info', key: 'host.net.forwardNoLan', vars: { port } });
    }
  }
  if (busyMediaPorts.length > 0) lines.push({ tone: 'warning', key: 'host.net.mediaBusy', vars: { ports: busyMediaPorts.join(', ') } });
  return lines;
}

/** The firewall line, and whether "Corrigir firewall" should be offered; null when not on Windows. */
export function firewallLine(status: FirewallStatus | null, profilesText: string): { line: NetworkLine; offerFix: boolean } | null {
  if (status === null) return { line: { tone: 'info', key: 'host.firewall.checking' }, offerFix: false };
  switch (status.state) {
    case 'unsupported':
      return null;
    case 'allowed':
      return { line: { tone: 'ok', key: 'host.firewall.allowed' }, offerFix: false };
    case 'blocked':
      return { line: { tone: 'error', key: 'host.firewall.blocked' }, offerFix: true };
    case 'missing':
      return { line: { tone: 'warning', key: 'host.firewall.missing', vars: { profiles: profilesText } }, offerFix: true };
    case 'off':
      return { line: { tone: 'info', key: 'host.firewall.off' }, offerFix: false };
    case 'unknown':
      return { line: { tone: 'info', key: 'host.firewall.unknown' }, offerFix: true };
  }
}
