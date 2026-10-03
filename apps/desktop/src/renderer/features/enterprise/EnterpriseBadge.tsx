import { useT } from '../../i18n/index.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import e from './enterprise.module.css';

/** "ENTERPRISE" next to the server's name, for everyone, while the server is Enterprise. */
export function EnterpriseBadge() {
  const t = useT();
  const enterprise = useEnterpriseStore((s) => s.edition === 'enterprise');
  if (!enterprise) return null;
  return (
    <span className={e.badge} title={t('enterprise.badgeTitle')} data-enterprise-badge>
      {t('enterprise.badge')}
    </span>
  );
}
