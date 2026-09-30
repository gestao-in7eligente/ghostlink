import { useId, useState, type FormEvent } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { normalizeFriendCode, type FriendsSnapshot } from '../../../shared/friendsTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { ConfirmDialog, primitives as p } from '../../layout/primitives.js';
import { useFriendsStore } from '../../stores/friends.js';
import f from './friends.module.css';

/**
 * "Adicionar amigo": paste someone's code to send a request, and this person's own code
 * to hand out (copy, make a new one, stop taking requests by code).
 */
export function AddFriendPanel({ snapshot }: { snapshot: FriendsSnapshot }) {
  const t = useT();
  const inputId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const { run } = useFriendsStore.getState();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const valid = normalizeFriendCode(code);
    setSent(false);
    if (!valid) {
      setError(errorMessage(t, 'FRIEND_CODE_INVALID'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(() => window.ghostlink.friends.add(valid));
      setCode('');
      setSent(true);
    } catch (err) {
      setError(errorMessage(t, errorCodeOf(err)));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!snapshot.code) return;
    await window.ghostlink.app.copyText(snapshot.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className={f.addArea}>
      <form className={f.addForm} onSubmit={(e) => void submit(e)}>
        <h2 className={f.addTitle}>{t('friends.add')}</h2>
        <p className={f.addLead}>{t('friends.add.lead')}</p>
        <div className={f.addRow}>
          <label className={f.visuallyHidden} htmlFor={inputId}>
            {t('friends.add.label')}
          </label>
          <input
            id={inputId}
            className={f.addInput}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setSent(false);
            }}
            placeholder={t('friends.add.placeholder')}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            disabled={busy}
          />
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || code.trim() === ''}>
            {busy ? t('friends.add.sending') : t('friends.add.submit')}
          </button>
        </div>
        {error && (
          <p className={f.error} role="alert">
            {error}
          </p>
        )}
        {sent && (
          <p className={f.success} role="status">
            {t('friends.add.sent')}
          </p>
        )}
      </form>

      {snapshot.code && (
        <section className={f.codeCard} aria-labelledby={`${inputId}-mine`}>
          <h2 id={`${inputId}-mine`} className={f.addTitle}>
            {t('friends.code.title')}
          </h2>
          <p className={f.addLead}>{t('friends.code.hint')}</p>
          <code className={f.code}>{snapshot.code}</code>
          <div className={f.codeActions}>
            <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => void copy()}>
              <Copy size={16} aria-hidden="true" />
              {copied ? t('friends.code.copied') : t('friends.code.copy')}
            </button>
            <button type="button" className={p.button} onClick={() => setConfirmNew(true)}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('friends.code.new')}
            </button>
          </div>
          <label className={f.toggle}>
            <input
              type="checkbox"
              checked={snapshot.inboxEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                run(() => window.ghostlink.friends.setInbox(enabled)).catch((err: unknown) => setError(errorMessage(t, errorCodeOf(err))));
              }}
            />
            {t('friends.code.inbox')}
          </label>
        </section>
      )}

      {confirmNew && (
        <ConfirmDialog
          title={t('friends.code.newTitle')}
          body={t('friends.code.newBody')}
          confirmLabel={t('friends.code.newConfirm')}
          danger={false}
          onConfirm={() => run(() => window.ghostlink.friends.newCode())}
          onClose={() => setConfirmNew(false)}
        />
      )}
    </div>
  );
}
