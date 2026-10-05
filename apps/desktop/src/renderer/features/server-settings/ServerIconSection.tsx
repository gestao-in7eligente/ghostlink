import { useId, useRef, useState } from 'react';
import { FEATURE_SERVER_ICON } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, ServerIcon, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useConnectionStore } from '../../stores/connection.js';
import { useTextStore } from '../../stores/text.js';
import { clearServerIcon } from '../chat/actions.js';
import { AvatarCropModal } from '../profile/AvatarCropModal.js';
import x from '../profile/profile.module.css';
import { IMAGE_ACCEPT, usePickedImage } from '../profile/usePickedImage.js';

/**
 * "Ícone do servidor" at the top of Visão geral (spec 2026-10-01-icone-do-servidor): the icon at
 * 80 px with "Alterar ícone" (the profile photo's crop modal and limits) and, when there is one,
 * "Remover ícone". The tab already needs MANAGE_SERVER; a server without the `serverIcon` flag
 * shows nothing here.
 */
export function ServerIconSection() {
  const t = useT();
  const titleId = useId();
  const serverId = useTextStore((st) => st.server.serverId);
  const name = useTextStore((st) => st.server.name);
  const icon = useTextStore((st) => st.server.icon);
  const takesIcons = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_SERVER_ICON) ?? false);
  const input = useRef<HTMLInputElement>(null);
  const { picked, close, opening, error, setError, onFile } = usePickedImage(t('profile.photo.unreadable'));
  const [removing, setRemoving] = useState(false);

  if (!takesIcons || serverId === null) return null;

  const remove = async () => {
    setError(null);
    setRemoving(true);
    try {
      await clearServerIcon();
    } catch (e) {
      setError({ code: errorCodeOf(e) });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className={x.photo} aria-labelledby={titleId} data-server-icon-section>
      <h4 id={titleId} className={`${s.label} ${x.title}`}>
        {t('serverIcon.title')}
      </h4>
      <div className={x.photoRow}>
        <ServerIcon name={name} hash={icon} size={80} />
        <div className={x.photoActions}>
          <div className={x.buttons}>
            <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => input.current?.click()} disabled={opening || removing}>
              {t('serverIcon.change')}
            </button>
            {icon && (
              <button type="button" className={x.linkButton} onClick={() => void remove()} disabled={opening || removing}>
                {t('serverIcon.remove')}
              </button>
            )}
          </div>
          <p className={s.hint}>{t('serverIcon.hint')}</p>
        </div>
      </div>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => void onFile(e)} />
      {error && ('code' in error ? <ErrorText code={error.code} /> : <p className={p.error} role="alert">{error.text}</p>)}
      {picked && <AvatarCropModal picked={picked} onApply={(bytes) => window.ghostlink.profile.setServerIcon(serverId, bytes)} onClose={close} />}
    </section>
  );
}
