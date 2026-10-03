import { TriangleAlert } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { isOwner } from '../../stores/server.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import e from './enterprise.module.css';
import { licenseBanner } from './enterpriseModel.js';

/** The owner's amber band: the license expires within 7 days, or lapsed and is in its 7 days of grace. */
export function EnterpriseBanner() {
  const t = useT();
  const owner = useTextStore((st) => isOwner(st.server));
  const license = useEnterpriseStore((s) => s.license);
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const banner = licenseBanner(license, owner);
  if (!banner) return null;
  return (
    <div className={e.banner} role="status" aria-label={t('enterprise.bannerLabel')} data-enterprise-banner>
      <TriangleAlert className={e.bannerIcon} size={16} aria-hidden="true" />
      <p className={e.bannerText}>{t(banner.key, { date: new Date(banner.date).toLocaleDateString(locale) })}</p>
    </div>
  );
}
