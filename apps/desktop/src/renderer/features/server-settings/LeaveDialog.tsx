import { useT } from '../../i18n/index.js';
import { ConfirmDialog } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { leaveServer } from '../chat/actions.js';
import { LeaveServerDialog } from '../serverDelete/ServerExitDialogs.js';

/**
 * "Sair do servidor" (spec §7; leave/delete spec §2) on the open server: membership ends,
 * optionally with all my messages, and the server leaves the saved list too. When the server
 * cannot be reached, "Tirar só da minha lista". The owner deletes instead (DeleteServerDialog).
 */
export function LeaveDialog({
  serverId,
  onClose,
  onLeaving,
  onLeft,
}: {
  serverId: string;
  onClose: () => void;
  /** The server ends the session right after the answer: the layout must not read that as a kick. */
  onLeaving: (active: boolean) => void;
  onLeft: () => void;
}) {
  const t = useT();
  const name = useTextStore((st) => st.server.name);
  const owner = useTextStore((st) => isOwner(st.server));

  if (owner) {
    return (
      <ConfirmDialog title={t('leave.title', { name })} body={t('leave.body')} confirmLabel={t('leave.confirm')} onConfirm={() => Promise.reject(new Error('OWNER_MUST_TRANSFER'))} onClose={onClose}>
        <p className={s.warning}>{t('leave.ownerMustTransfer')}</p>
      </ConfirmDialog>
    );
  }

  const leave = async (deleteMine: boolean) => {
    onLeaving(true);
    try {
      await leaveServer(deleteMine);
    } catch (e) {
      onLeaving(false);
      throw e;
    }
    await window.ghostlink.servers.remove(serverId).catch(() => undefined);
    onLeft();
  };

  const removeOnly = async () => {
    onLeaving(true);
    try {
      await window.ghostlink.servers.remove(serverId);
    } catch (e) {
      onLeaving(false);
      throw e;
    }
    onLeft();
  };

  return <LeaveServerDialog name={name} onLeave={leave} onRemoveOnly={removeOnly} onClose={onClose} />;
}
