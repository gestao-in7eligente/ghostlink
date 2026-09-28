import { useT } from '../../i18n/index.js';
import host from './host.module.css';
import { hostIndicator, useHostStore } from './hostStore.js';
import { openHostPanel } from './hostUi.js';

/**
 * The "Hospedando <nome>" pill, shown while a server is hosted here; it opens the
 * Host panel. Floating (bottom-left) by default; `inline` lets a layout place it.
 */
export function HostIndicator({ inline = false, onOpen = openHostPanel }: { inline?: boolean; onOpen?: () => void }) {
  const t = useT();
  const shown = hostIndicator(useHostStore((s) => s.status));
  if (shown === null) return null;
  const dot = shown.kind === 'running' ? `${host.live} ${host.liveOn}` : shown.kind === 'failed' ? `${host.live} ${host.liveBad}` : host.live;
  return (
    <button type="button" className={inline ? host.indicator : `${host.indicator} ${host.floating}`} onClick={onOpen} title={t('host.indicator.open')}>
      <span className={dot} aria-hidden="true" />
      <span className={host.indicatorText}>{t(`host.indicator.${shown.kind}`, { name: shown.name })}</span>
    </button>
  );
}
