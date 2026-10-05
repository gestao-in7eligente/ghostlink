import { useEffect, useId, useRef, useState } from 'react';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { Avatar, ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useProfileStore } from '../../stores/profile.js';
import { AvatarCropModal } from './AvatarCropModal.js';
import x from './profile.module.css';
import { IMAGE_ACCEPT, usePickedImage } from './usePickedImage.js';

/**
 * The top of the Perfil tab (spec 2026-10-01-foto-de-perfil §2): my photo at 80 px,
 * "Alterar foto" (a file that is too big or does not decode never opens the crop modal)
 * and, when I have one, "Remover foto". One photo for every server.
 */
export function ProfilePhoto({ name }: { name: string }) {
  const t = useT();
  const titleId = useId();
  const avatar = useProfileStore((st) => st.avatar);
  const input = useRef<HTMLInputElement>(null);
  const { picked, close, opening, error, setError, onFile } = usePickedImage(t('profile.photo.unreadable'));
  const [removing, setRemoving] = useState(false);

  // A load that failed earlier (main busy at start-up) is tried again here.
  useEffect(() => {
    if (useProfileStore.getState().status !== 'ready') void useProfileStore.getState().load();
  }, []);

  const remove = async () => {
    setError(null);
    setRemoving(true);
    try {
      await useProfileStore.getState().clear();
    } catch (e) {
      setError({ code: errorCodeOf(e) });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className={x.photo} aria-labelledby={titleId} data-profile-photo>
      <h4 id={titleId} className={`${s.label} ${x.title}`}>
        {t('profile.photo.title')}
      </h4>
      <div className={x.photoRow}>
        <Avatar size={80} name={name} self />
        <div className={x.photoActions}>
          <div className={x.buttons}>
            <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => input.current?.click()} disabled={opening || removing}>
              {t('profile.photo.change')}
            </button>
            {avatar && (
              <button type="button" className={x.linkButton} onClick={() => void remove()} disabled={opening || removing}>
                {t('profile.photo.remove')}
              </button>
            )}
          </div>
          <p className={s.hint}>{t('profile.photo.hint')}</p>
        </div>
      </div>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => void onFile(e)} />
      {error && ('code' in error ? <ErrorText code={error.code} /> : <p className={p.error} role="alert">{error.text}</p>)}
      {picked && <AvatarCropModal picked={picked} onApply={(bytes) => useProfileStore.getState().set(bytes)} onClose={close} />}
    </section>
  );
}
