import { useT } from '../../i18n/index.js';
import { Modal, primitives as p } from '../../layout/primitives.js';
import { useChannelLinkNotice } from './openChannelLink.js';

/** A channel link of a server that is not in my list (channel menu §2): "Você não está nesse servidor". */
export function ChannelLinkNotice() {
  const t = useT();
  const open = useChannelLinkNotice((s) => s.unknownServer);
  if (!open) return null;
  const dismiss = () => useChannelLinkNotice.getState().dismiss();
  return (
    <Modal
      title={t('channelLink.unknownTitle')}
      onClose={dismiss}
      footer={
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={dismiss}>
          {t('channelLink.ok')}
        </button>
      }
    >
      <p className={p.text}>{t('channelLink.unknownBody')}</p>
    </Modal>
  );
}
