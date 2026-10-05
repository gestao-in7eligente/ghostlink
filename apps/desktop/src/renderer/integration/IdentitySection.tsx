import ui from '../components/ui.module.css';
import { openIdentitySettings } from '../features/identity/identityModel.js';
import { useT } from '../i18n/index.js';
import s from './integration.module.css';

/** User settings → "Identidade": opens the identity/backup dialog (spec §3.4). */
export function IdentitySection() {
  const t = useT();
  return (
    <div className={s.section}>
      <p className={s.optionDesc}>{t('identity.settings.intro')}</p>
      <div>
        <button type="button" className={`${ui.button} ${ui.primary}`} onClick={openIdentitySettings}>
          {t('identity.section.manage')}
        </button>
      </div>
    </div>
  );
}
