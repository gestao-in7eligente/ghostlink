import { useEffect, useState, type FormEvent } from 'react';
import type { AppLicenseInfo } from '../../../shared/ipcTypes.js';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useSettingsStore } from '../../stores/settings.js';
import e from './license.module.css';

/**
 * "Licença" in the app settings, right below Perfil (v0.9): the owner enters their registration key.
 * On Ativar the client validates it with the license service and unlocks the paid edition, showing the
 * server quota the panel set. The key stays in main (never here); only the state comes back.
 */
export function LicenseTab() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [info, setInfo] = useState<AppLicenseInfo | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.ghostlink.license.info().then((i) => alive && setInfo(i), () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const activate = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy || key.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await window.ghostlink.license.activate(key));
      setKey('');
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await window.ghostlink.license.clear());
    } finally {
      setBusy(false);
    }
  };

  const date = (at: number | null) => (at === null ? '' : new Date(at).toLocaleDateString(locale));

  if (info?.active) {
    return (
      <div className={s.form}>
        <div className={e.card} data-license-active>
          <p className={e.cardTitle}>{t('license.active.title')}</p>
          {info.company !== null && <p className={e.cardLine}>{t('license.active.company', { company: info.company })}</p>}
          <p className={e.cardLine} data-license-quota>
            {t('license.active.quota', { used: info.used, max: info.maxServers })}
          </p>
          {info.validUntil !== null && <p className={e.cardLine}>{t('license.active.until', { date: date(info.validUntil) })}</p>}
        </div>
        <p className={s.hint}>{t('license.activeHint')}</p>
        {error && <ErrorText code={error} />}
        <div className={s.row}>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={busy} onClick={() => void remove()}>
            {t('license.remove')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className={s.form} onSubmit={(ev) => void activate(ev)}>
      <p className={p.text}>{t('license.lead')}</p>
      <div className={s.field}>
        <label htmlFor="license-key" className={s.label}>
          {t('license.key')}
        </label>
        <input
          id="license-key"
          className={s.input}
          type="password"
          placeholder="GLE-XXXX-XXXX-XXXX-XXXX"
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          value={key}
          disabled={busy}
          onChange={(ev) => setKey(ev.target.value)}
        />
        <p className={s.hint}>{t('license.hint')}</p>
      </div>
      {error && <ErrorText code={error} />}
      <div className={s.row}>
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || key.trim() === ''}>
          {busy ? t('license.checking') : t('license.activate')}
        </button>
      </div>
    </form>
  );
}
