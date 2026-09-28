import { useState } from 'react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { IdentityStatus } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { openBackupImport } from '../features/identity/identityModel.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';

/**
 * spec §3.1: identity.bin exists but cannot be decrypted. Nothing is ever
 * overwritten here: retry, import a .ghostkey backup (the locked file is kept aside), or — after two confirmations — move
 * the old file aside and create a new identity.
 */
export function IdentityLocked({ onStatus }: { onStatus: (status: IdentityStatus) => void }) {
  const t = useT();
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [stillLocked, setStillLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = () =>
    run(async () => {
      const status = await window.ghostlink.identity.retry();
      if (status === 'locked') setStillLocked(true);
      else onStatus(status);
    });

  const replace = () =>
    run(async () => {
      await window.ghostlink.identity.replaceKeepingBackup();
      await window.ghostlink.identity.create();
      onStatus('ready');
    });

  return (
    <Screen title={t('identityLocked.title')}>
      <p className={ui.text}>{t('identityLocked.body')}</p>
      {stillLocked && <p className={ui.warning}>{t('identityLocked.stillLocked')}</p>}
      <ErrorLine text={error && errorMessage(t, error)} />
      {confirmStep === 0 && (
        <div className={ui.actions}>
          <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={() => setConfirmStep(1)}>
            {t('identityLocked.replace')}
          </button>
          <button type="button" className={ui.button} disabled={busy} onClick={openBackupImport}>
            {t('identityLocked.import')}
          </button>
          <button type="button" className={`${ui.button} ${ui.primary}`} disabled={busy} onClick={() => void retry()}>
            {t('common.tryAgain')}
          </button>
        </div>
      )}
      {confirmStep === 1 && (
        <>
          <p className={ui.warning}>{t('identityLocked.confirm1')}</p>
          <div className={ui.actions}>
            <button type="button" className={ui.button} onClick={() => setConfirmStep(0)}>
              {t('common.cancel')}
            </button>
            <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => setConfirmStep(2)}>
              {t('identityLocked.confirm1Button')}
            </button>
          </div>
        </>
      )}
      {confirmStep === 2 && (
        <>
          <p className={ui.warning}>{t('identityLocked.confirm2')}</p>
          <div className={ui.actions}>
            <button type="button" className={ui.button} disabled={busy} onClick={() => setConfirmStep(0)}>
              {t('common.cancel')}
            </button>
            <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={() => void replace()}>
              {t('identityLocked.confirm2Button')}
            </button>
          </div>
        </>
      )}
    </Screen>
  );
}
