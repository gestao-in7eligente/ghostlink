import { LogIn, Server } from 'lucide-react';
import { HostDialog } from '../features/host/HostDialog.js';
import { openHostFlow } from '../features/host/hostUi.js';
import { useT } from '../i18n/index.js';
import { useAddServerUi } from './addServerUi.js';
import s from './integration.module.css';

/** "Adicionar servidor": opened by the rail's "+" (right below the home button). */
export function AddServerModal() {
  const t = useT();
  const open = useAddServerUi((u) => u.chooser);
  if (!open) return null;
  const { closeChooser, openJoin } = useAddServerUi.getState();
  const create = () => {
    closeChooser();
    openHostFlow();
  };
  return (
    <HostDialog title={t('addServer.title')} closeLabel={t('ui.close')} onClose={closeChooser}>
      <p className={s.lead}>{t('addServer.lead')}</p>
      <div className={s.options}>
        <button type="button" className={s.option} onClick={create} data-autofocus>
          <span className={s.optionIcon} aria-hidden="true">
            <Server size={22} />
          </span>
          <span className={s.optionText}>
            <span className={s.optionTitle}>{t('addServer.create.title')}</span>
            <span className={s.optionDesc}>{t('addServer.create.desc')}</span>
          </span>
        </button>
        <button type="button" className={s.option} onClick={openJoin}>
          <span className={s.optionIcon} aria-hidden="true">
            <LogIn size={22} />
          </span>
          <span className={s.optionText}>
            <span className={s.optionTitle}>{t('addServer.join.title')}</span>
            <span className={s.optionDesc}>{t('addServer.join.desc')}</span>
          </span>
        </button>
      </div>
    </HostDialog>
  );
}
