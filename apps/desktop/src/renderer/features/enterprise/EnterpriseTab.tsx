import { useId, useState, type FormEvent } from 'react';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useConnectionStore } from '../../stores/connection.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { useSettingsStore } from '../../stores/settings.js';
import { CopyField } from '../server-settings/InviteDialog.js';
import e from './enterprise.module.css';
import { setLicense } from './enterpriseActions.js';
import { enterpriseView } from './enterpriseModel.js';

/** "Enterprise" in the server settings (the owner only): the edition, the license's state, and pasting a new license. */
export function EnterpriseTab() {
  const t = useT();
  const pasteId = useId();
  const edition = useEnterpriseStore((st) => st.edition);
  const license = useEnterpriseStore((st) => st.license);
  const keyId = useConnectionStore((st) => st.welcome?.server.serverKeyId ?? '');
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);
  const date = (at: number | null) => (at === null ? '' : new Date(at).toLocaleDateString(locale));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await setLicense(text);
      setText('');
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const view = enterpriseView(edition, license, Date.now());
  const n = view.mode === 'enterprise' ? view.days : 0;
  const plural = (one: 'enterprise.tab.card.daysLeft.one' | 'enterprise.tab.card.expiring.one', other: 'enterprise.tab.card.daysLeft.other' | 'enterprise.tab.card.expiring.other') =>
    t(n === 1 ? one : other, { n });

  const pasteForm = (
    <>
      <CopyField label={t('enterprise.tab.identity')} value={keyId} />
      <p className={s.hint}>{t('enterprise.tab.identityHint')}</p>
      <form className={s.form} onSubmit={(ev) => void submit(ev)}>
        <div className={s.field}>
          <label htmlFor={pasteId} className={s.label}>
            {t('enterprise.tab.paste')}
          </label>
          <textarea
            id={pasteId}
            className={`${s.textarea} ${e.license}`}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            value={text}
            disabled={busy}
            onChange={(ev) => {
              setText(ev.target.value);
              setDone(false);
            }}
          />
          <p className={s.hint}>{t('enterprise.tab.pasteHint')}</p>
        </div>
        {error && <ErrorText code={error} />}
        {done && <p className={s.ok}>{t('enterprise.tab.saved')}</p>}
        <div className={s.row}>
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || text.trim() === ''}>
            {t('enterprise.tab.save')}
          </button>
        </div>
      </form>
    </>
  );

  if (view.mode === 'enterprise') {
    const toneClass = view.tone === 'warning' ? e.cardWarning : view.tone === 'danger' ? e.cardDanger : '';
    return (
      <div className={s.form}>
        <div className={`${e.card} ${toneClass}`} data-enterprise-card data-tone={view.tone}>
          <p className={e.cardTitle}>{t('enterprise.tab.card.active')}</p>
          <p className={e.cardLine}>{t('enterprise.tab.card.company', { company: view.company })}</p>
          <p className={e.cardLine}>{t('enterprise.tab.card.until', { date: date(view.expiresAt) })}</p>
          <p className={e.cardLine} data-enterprise-days>
            {view.tone === 'ok' && plural('enterprise.tab.card.daysLeft.one', 'enterprise.tab.card.daysLeft.other')}
            {view.tone === 'warning' && plural('enterprise.tab.card.expiring.one', 'enterprise.tab.card.expiring.other')}
            {view.tone === 'danger' &&
              t(`enterprise.tab.card.grace.${n === 0 ? 'zero' : n === 1 ? 'one' : 'other'}`, { date: date(view.expiresAt), n })}
          </p>
        </div>
        <p className={s.hint}>{t('enterprise.tab.intro')}</p>
        {open ? (
          pasteForm
        ) : (
          <div className={s.row}>
            <button type="button" className={`${p.button} ${p.buttonSecondary}`} onClick={() => setOpen(true)}>
              {t('enterprise.tab.renew')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={s.form}>
      <p className={p.text}>{t('enterprise.tab.intro')}</p>
      <p className={p.text} data-enterprise-edition>
        {t(edition === 'enterprise' ? 'enterprise.tab.edition.enterprise' : 'enterprise.tab.edition.normal')}
      </p>
      <p className={s.hint} data-enterprise-state>
        {license
          ? t(`enterprise.tab.state.${license.state}`, {
              company: license.company ?? '',
              date: date(license.expiresAt),
              grace: date(license.graceEndsAt),
            })
          : t('enterprise.tab.none')}
      </p>
      {pasteForm}
    </div>
  );
}
