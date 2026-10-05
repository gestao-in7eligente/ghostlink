import { LogIn, Server } from 'lucide-react';
import { useT } from '../i18n/index.js';
import l from './layout.module.css';
import { Modal } from './primitives.js';
import { addServerActions } from './rail.js';
import { useLayoutSlots } from './slots.js';

/**
 * "Adicionar servidor" (owner's UI reference): opened by the rail's "+". A modal
 * (Esc, backdrop and X close it; focus stays inside) with two large option cards,
 * "Criar um servidor" and "Entrar em um servidor".
 */
export function AddServerDialog({ onClose, onHome }: { onClose: () => void; onHome: () => void }) {
  const t = useT();
  const onCreateServer = useLayoutSlots((s) => s.onCreateServer);
  const onJoinServer = useLayoutSlots((s) => s.onJoinServer);
  const actions = addServerActions({ onCreateServer, onJoinServer }, onHome);
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Modal title={t('layout.addServer')} onClose={onClose} size="medium">
      <div className={l.addOptions}>
        <button type="button" className={l.addOption} onClick={pick(actions.create)}>
          <span className={l.addOptionIcon} aria-hidden="true">
            <Server size={22} />
          </span>
          <span className={l.addOptionText}>
            <span className={l.addOptionTitle}>{t('layout.addServer.create')}</span>
            <span className={l.addOptionHint}>{t('layout.addServer.createHint')}</span>
          </span>
        </button>
        <button type="button" className={l.addOption} onClick={pick(actions.join)}>
          <span className={l.addOptionIcon} aria-hidden="true">
            <LogIn size={22} />
          </span>
          <span className={l.addOptionText}>
            <span className={l.addOptionTitle}>{t('layout.addServer.join')}</span>
            <span className={l.addOptionHint}>{t('layout.addServer.joinHint')}</span>
          </span>
        </button>
      </div>
    </Modal>
  );
}
