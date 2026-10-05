import { RadioTower } from 'lucide-react';
import { hostIndicator, useHostStore } from '../features/host/hostStore.js';
import { openHostPanel } from '../features/host/hostUi.js';
import { useT } from '../i18n/index.js';
import l from '../layout/layout.module.css';
import s from './integration.module.css';

/**
 * In the main layout the floating "Hospedando …" pill would cover the user panel,
 * so the rail shows a round button instead (only while a server is hosted here).
 */
export function HostRailButton() {
  const t = useT();
  const shown = hostIndicator(useHostStore((st) => st.status));
  if (shown === null) return null;
  const label = t(`host.indicator.${shown.kind}`, { name: shown.name });
  return (
    <div className={l.railItem}>
      <button type="button" className={`${l.railButton} ${s.hostRail}`} onClick={openHostPanel} aria-label={label} title={label}>
        <RadioTower size={20} aria-hidden="true" />
        <span className={`${s.hostDot} ${s[shown.kind]}`} aria-hidden="true" />
      </button>
    </div>
  );
}
