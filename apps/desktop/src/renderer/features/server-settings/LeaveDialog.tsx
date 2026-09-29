import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ConfirmDialog } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { leaveServer } from '../chat/actions.js';

/**
 * "Sair do servidor" (spec §7): membership ends, optionally with all my messages.
 * The owner must transfer ownership first. The server leaves the saved list too.
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
  const [deleteMine, setDeleteMine] = useState(false);

  const leave = async () => {
    if (owner) throw new Error('OWNER_MUST_TRANSFER');
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

  return (
    <ConfirmDialog title={t('leave.title', { name })} body={t('leave.body')} confirmLabel={t('leave.confirm')} onConfirm={leave} onClose={onClose}>
      {owner ? (
        <p className={s.warning}>{t('leave.ownerMustTransfer')}</p>
      ) : (
        <label className={s.check}>
          <input type="checkbox" checked={deleteMine} onChange={(e) => setDeleteMine(e.target.checked)} />
          <span className={s.hint}>{t('leave.deleteMessages')}</span>
        </label>
      )}
    </ConfirmDialog>
  );
}
