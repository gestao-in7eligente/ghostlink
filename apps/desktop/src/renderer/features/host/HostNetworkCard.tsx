import { useEffect, useState } from 'react';
import type { FirewallFixResult, FirewallStatus, HostStatus } from '../../../shared/hostTypes.js';
import ui from '../../components/ui.module.css';
import { useT, type MessageKey } from '../../i18n/index.js';
import host from './host.module.css';
import { firewallLine, networkLines, type NetworkLine } from './hostNetworkModel.js';

const TONE_CLASS: Record<NetworkLine['tone'], string> = {
  ok: host.lineOk!,
  info: host.lineInfo!,
  warning: host.lineWarning!,
  error: host.lineError!,
};

const FIX_MESSAGE: Record<Exclude<FirewallFixResult, 'unsupported'>, MessageKey> = {
  done: 'host.firewall.done',
  cancelled: 'host.firewall.cancelled',
  failed: 'host.firewall.failed',
};

/** spec §8.5 / §11.1 screen 3: UPnP, CGNAT, port forwarding, Windows Firewall and the bandwidth note. */
export function HostNetworkCard({ status }: { status: HostStatus }) {
  const t = useT();
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<FirewallFixResult | null>(null);

  useEffect(() => {
    let alive = true;
    window.ghostlink.host.firewall().then(
      (s) => alive && setFirewall(s),
      () => alive && setFirewall({ state: 'unknown', activeProfiles: [] }),
    );
    return () => {
      alive = false;
    };
  }, []);

  const fix = async () => {
    setFixing(true);
    setFixResult(null);
    try {
      const { result, status: after } = await window.ghostlink.host.fixFirewall();
      setFirewall(after);
      setFixResult(result);
    } catch {
      setFixResult('failed');
    } finally {
      setFixing(false);
    }
  };

  const profiles = (firewall?.activeProfiles ?? [])
    .map((p) => (['Public', 'Private', 'DomainAuthenticated'].includes(p) ? t(`host.firewall.profile.${p as 'Public'}`) : p))
    .join(', ');
  const lines = networkLines(status.network, status.port, status.busyMediaPorts);
  const fw = firewallLine(firewall, profiles);
  const line = (l: NetworkLine, i: number) => (
    <li key={`${l.key}-${i}`} className={`${host.line} ${TONE_CLASS[l.tone]}`}>
      <span className={host.lineDot} aria-hidden="true" />
      <span>{t(l.key, l.vars)}</span>
    </li>
  );

  return (
    <section className={host.card} aria-labelledby="host-network">
      <h2 id="host-network" className={host.cardTitle}>
        {t('host.net.title')}
      </h2>
      <ul className={host.lines}>
        {lines.map(line)}
        {fw && line(fw.line, lines.length)}
      </ul>
      {fw?.offerFix && (
        <div className={host.row}>
          <button type="button" className={ui.button} disabled={fixing} onClick={() => void fix()}>
            {t('host.firewall.fix')}
          </button>
          <span className={ui.hint}>{t('host.firewall.fixHint')}</span>
        </div>
      )}
      {fixResult && fixResult !== 'unsupported' && (
        <p className={fixResult === 'done' ? ui.hint : ui.warning} role="status">
          {t(FIX_MESSAGE[fixResult])}
        </p>
      )}
      <p className={ui.hint}>{t('host.net.bandwidth')}</p>
    </section>
  );
}
