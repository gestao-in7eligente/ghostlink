import { useEffect } from 'react';
import { Cloud, Monitor } from 'lucide-react';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { RailwayWizard } from '../features/railway/RailwayWizard.js';
import { useRailwayStore } from '../features/railway/railwayStore.js';
import { useT } from '../i18n/index.js';
import l from '../layout/layout.module.css';
import { Modal } from '../layout/primitives.js';
import { chooseLocal, chooseRailway, closeCreateServer, useCreateServerUi } from './createServerUi.js';

/** "Criar um servidor": where the server lives, as two big cards like "Adicionar servidor". */
function CreateServerDialog() {
  const t = useT();
  return (
    <Modal title={t('create.title')} onClose={closeCreateServer} size="medium">
      <p className={l.addOptionHint}>{t('create.lead')}</p>
      <div className={l.addOptions}>
        <button type="button" className={l.addOption} onClick={chooseLocal}>
          <span className={l.addOptionIcon} aria-hidden="true">
            <Monitor size={22} />
          </span>
          <span className={l.addOptionText}>
            <span className={l.addOptionTitle}>{t('create.local.title')}</span>
            <span className={l.addOptionHint}>{t('create.local.desc')}</span>
          </span>
        </button>
        <button type="button" className={l.addOption} onClick={chooseRailway}>
          <span className={l.addOptionIcon} aria-hidden="true">
            <Cloud size={22} />
          </span>
          <span className={l.addOptionText}>
            <span className={l.addOptionTitle}>{t('create.railway.title')}</span>
            <span className={l.addOptionHint}>{t('create.railway.desc')}</span>
          </span>
        </button>
      </div>
    </Modal>
  );
}

/** App mounts this once; openCreateServer() (rail "+", onboarding) drives it from anywhere. */
export function CreateServerScreens({ onJoined }: { onJoined: (welcome: RendererWelcome) => void }) {
  const view = useCreateServerUi((s) => s.view);

  // Railway progress arrives from main whether the wizard is open or not.
  useEffect(() => window.ghostlink.railway.onProgress((p) => useRailwayStore.getState().progress(p)), []);

  if (view === 'choose') return <CreateServerDialog />;
  if (view === 'railway') {
    return (
      <RailwayWizard
        onClose={closeCreateServer}
        onJoined={(welcome) => {
          closeCreateServer();
          onJoined(welcome);
        }}
      />
    );
  }
  return null;
}
