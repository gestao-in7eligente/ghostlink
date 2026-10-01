import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { Avatar, ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useProfileStore } from '../../stores/profile.js';
import { AvatarCropModal, type PickedFile } from './AvatarCropModal.js';
import { browserCodecs } from './browserCodecs.js';
import { openAvatarFile } from './encodeAvatar.js';
import x from './profile.module.css';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

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
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [opening, setOpening] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<{ text: string } | { code: string } | null>(null);

  // A load that failed earlier (main busy at start-up) is tried again here.
  useEffect(() => {
    if (useProfileStore.getState().status !== 'ready') void useProfileStore.getState().load();
  }, []);

  // The blob: URL lives as long as the modal.
  useEffect(() => (picked ? () => URL.revokeObjectURL(picked.url) : undefined), [picked]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again still fires
    setError(null);
    if (!file) return;
    const unreadable = { text: t('profile.photo.unreadable') };
    if (file.size === 0 || file.size > AVATAR_LIMITS.inputMaxBytes) {
      setError(unreadable);
      return;
    }
    setOpening(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = await openAvatarFile(bytes, browserCodecs);
      setPicked({ ...image, bytes, url: URL.createObjectURL(new Blob([bytes], { type: image.mime })) });
    } catch {
      setError(unreadable);
    } finally {
      setOpening(false);
    }
  };

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
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void onFile(e)} />
      {error && ('code' in error ? <ErrorText code={error.code} /> : <p className={p.error} role="alert">{error.text}</p>)}
      {picked && <AvatarCropModal picked={picked} onClose={() => setPicked(null)} />}
    </section>
  );
}
