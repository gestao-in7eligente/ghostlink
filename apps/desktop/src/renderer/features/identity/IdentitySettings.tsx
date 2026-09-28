// spec §11.1 screen 7 "identidade": export, import and delete, as cards in the main-screen style.
import { useState, type FormEvent } from 'react';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { IdentityStatus } from '../../../shared/ipcTypes.js';
import { ErrorLine } from '../../components/Screen.js';
import ui from '../../components/ui.module.css';
import { errorCodeOf, errorMessage, useT, type MessageKey } from '../../i18n/index.js';
import host from '../host/host.module.css';
import { backupPasswordProblem, importConfirmationsNeeded, type PasswordProblem } from './identityModel.js';

const PROBLEM: Record<PasswordProblem, MessageKey> = {
  short: 'identity.export.short',
  long: 'identity.export.long',
  mismatch: 'identity.export.mismatch',
};

/** Password twice → native save dialog → .ghostkey. */
export function ExportBackup({ onExported }: { onExported?: (fileName: string) => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const problem = backupPasswordProblem(password, confirm);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await window.ghostlink.identity.exportBackup(password);
      if (result.saved && result.fileName) {
        setSaved(result.fileName);
        setPassword('');
        setConfirm('');
        setTouched(false);
        onExported?.(result.fileName);
      }
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={ui.form} onSubmit={(e) => void submit(e)} noValidate>
      <p className={ui.hint}>{t('identity.export.body')}</p>
      <div className={host.twoColumns}>
        <label className={ui.field}>
          <span className={ui.label}>{t('identity.export.password')}</span>
          <input className={ui.input} type="password" autoComplete="new-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>{t('identity.export.confirm')}</span>
          <input className={ui.input} type="password" autoComplete="new-password" value={confirm} disabled={busy} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      </div>
      <span className={ui.hint}>{t('identity.export.hint')}</span>
      <ErrorLine text={touched && problem ? t(PROBLEM[problem]) : error && errorMessage(t, error)} />
      {busy && <p className={ui.status}>{t('identity.export.working')}</p>}
      {saved && (
        <p className={ui.status} role="status">
          {t('identity.export.saved', { file: saved })}
        </p>
      )}
      <div className={host.footer}>
        <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={busy}>
          {t('identity.export.submit')}
        </button>
      </div>
    </form>
  );
}

/** Pick a .ghostkey → password → (two confirmations when an identity would be replaced) → import. */
export function ImportBackup({ status, onImported }: { status: IdentityStatus; onImported: (status: IdentityStatus) => void }) {
  const t = useT();
  const [fileName, setFileName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmStep, setConfirmStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const needed = importConfirmationsNeeded(status);

  const pick = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await window.ghostlink.identity.pickBackup();
      setFileName(r.picked ? r.fileName : null);
      setConfirmStep(0);
    } catch (e) {
      setFileName(null);
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.ghostlink.identity.importBackup(password, needed > 0);
      setPassword('');
      onImported(next);
    } catch (e) {
      setError(errorCodeOf(e));
      setConfirmStep(0);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password === '' || fileName === null) return;
    if (confirmStep < needed) setConfirmStep(1);
    else void doImport();
  };

  return (
    <form className={ui.form} onSubmit={submit} noValidate>
      <p className={ui.hint}>{t('identity.import.body')}</p>
      <div className={host.row}>
        <button type="button" className={ui.button} disabled={busy} onClick={() => void pick()}>
          {t('identity.import.pick')}
        </button>
        {fileName && <span className={ui.hint}>{t('identity.import.picked', { file: fileName })}</span>}
      </div>
      {fileName && (
        <label className={ui.field}>
          <span className={ui.label}>{t('identity.import.password')}</span>
          <input className={ui.input} type="password" autoComplete="current-password" value={password} disabled={busy} autoFocus onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      <ErrorLine text={error && errorMessage(t, error)} />
      {busy && fileName && <p className={ui.status}>{t('identity.import.working')}</p>}
      {confirmStep === 1 && <p className={ui.warning}>{t('identity.import.confirm1')}</p>}
      {confirmStep === 2 && <p className={ui.warning}>{t('identity.import.confirm2')}</p>}
      {fileName && (
        <div className={host.footer}>
          {confirmStep > 0 && (
            <button type="button" className={ui.button} disabled={busy} onClick={() => setConfirmStep(0)}>
              {t('common.cancel')}
            </button>
          )}
          {confirmStep === 1 ? (
            <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={() => setConfirmStep(2)}>
              {t('identity.import.confirm1Button')}
            </button>
          ) : confirmStep === 2 ? (
            <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={() => void doImport()}>
              {t('identity.import.confirm2Button')}
            </button>
          ) : (
            <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={busy || password === ''}>
              {t('identity.import.submit')}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

/** Two confirmations, with the export offered first (spec §3.1). */
export function DeleteIdentity({ onExportFirst, onDeleted }: { onExportFirst: () => void; onDeleted: (status: IdentityStatus) => void }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await window.ghostlink.identity.delete());
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={ui.form}>
      <p className={ui.hint}>{t('identity.delete.body')}</p>
      {step === 1 && <p className={ui.warning}>{t('identity.delete.confirm1')}</p>}
      {step === 2 && <p className={ui.warning}>{t('identity.delete.confirm2')}</p>}
      <ErrorLine text={error && errorMessage(t, error)} />
      <div className={host.footer}>
        {step > 0 && (
          <button type="button" className={ui.button} disabled={busy} onClick={() => setStep(0)}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" className={ui.button} disabled={busy} onClick={onExportFirst}>
          {t('identity.delete.exportFirst')}
        </button>
        <button
          type="button"
          className={`${ui.button} ${ui.danger}`}
          disabled={busy}
          onClick={() => (step < 2 ? setStep(step + 1) : void remove())}
        >
          {t(step === 0 ? 'identity.delete.start' : step === 1 ? 'identity.delete.confirm1Button' : 'identity.delete.confirm2Button')}
        </button>
      </div>
    </div>
  );
}

/** The whole "Identidade" section: a user-settings screen can render it inline. */
export function IdentitySettings({
  status,
  onChanged,
  onExportFirst,
}: {
  status: IdentityStatus;
  onChanged: (status: IdentityStatus) => void;
  onExportFirst: () => void;
}) {
  const t = useT();
  return (
    <>
      <p className={ui.text}>{t('identity.settings.intro')}</p>
      {status === 'ready' && (
        <section className={host.card} aria-labelledby="identity-export">
          <h2 id="identity-export" className={host.cardTitle}>
            {t('identity.export.title')}
          </h2>
          <ExportBackup />
        </section>
      )}
      <section className={host.card} aria-labelledby="identity-import">
        <h2 id="identity-import" className={host.cardTitle}>
          {t('identity.import.title')}
        </h2>
        <ImportBackup status={status} onImported={onChanged} />
      </section>
      {status === 'ready' && (
        <section className={host.card} aria-labelledby="identity-delete">
          <h2 id="identity-delete" className={host.cardTitle}>
            {t('identity.delete.title')}
          </h2>
          <DeleteIdentity onExportFirst={onExportFirst} onDeleted={onChanged} />
        </section>
      )}
    </>
  );
}
