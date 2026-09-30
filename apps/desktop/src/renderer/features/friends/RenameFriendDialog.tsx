import { useId, useState, type FormEvent } from 'react';
import { FRIEND_LOCAL_NAME_MAX, type Friend } from '../../../shared/friendsTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { Modal, primitives as p } from '../../layout/primitives.js';
import { useFriendsStore } from '../../stores/friends.js';
import f from './friends.module.css';

/** A nickname only this person sees; empty clears it. */
export function RenameFriendDialog({ friend, name, onClose }: { friend: Friend; name: string; onClose: () => void }) {
  const t = useT();
  const inputId = useId();
  const [value, setValue] = useState(friend.localName ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async (localName: string | null) => {
    try {
      await useFriendsStore.getState().run(() => window.ghostlink.friends.rename(friend.key, localName));
      onClose();
    } catch (e) {
      setError(errorMessage(t, errorCodeOf(e)));
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    void save(trimmed === '' ? null : trimmed);
  };

  return (
    <Modal title={t('friends.rename.title', { name })} onClose={onClose}>
      <form className={f.renameForm} onSubmit={submit}>
        <label className={f.fieldLabel} htmlFor={inputId}>
          {t('friends.rename.label')}
        </label>
        <input id={inputId} className={f.addInput} value={value} maxLength={FRIEND_LOCAL_NAME_MAX} onChange={(e) => setValue(e.target.value)} autoFocus />
        {error && (
          <p className={f.error} role="alert">
            {error}
          </p>
        )}
        <div className={f.codeActions}>
          {friend.localName !== null && (
            <button type="button" className={p.button} onClick={() => void save(null)}>
              {t('friends.rename.clear')}
            </button>
          )}
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`}>
            {t('friends.rename.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
