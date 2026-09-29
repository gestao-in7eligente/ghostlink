import { useEffect, useId, useState } from 'react';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { UpdateState } from '../../../shared/updates.js';
import { ErrorLine } from '../../components/Screen.js';
import { errorCodeOf, errorMessage, useT, type Translate } from '../../i18n/index.js';
import { syncUpdates, useUpdateStore } from './store.js';
import styles from './UpdateSettings.module.css';

function statusText(t: Translate, state: UpdateState): string {
  const version = state.version ?? '?';
  switch (state.status) {
    case 'unsupported':
      return t('updates.settings.unsupported');
    case 'disabled':
      return t('updates.status.disabled');
    case 'checking':
      return t('updates.status.checking');
    case 'downloading':
      return t('updates.status.downloading', { version, percent: state.percent ?? 0 });
    case 'downloaded':
      return t('updates.status.downloaded', { version });
    case 'rejected':
      return t('updates.banner.rejected', { version });
    case 'idle':
      return t('updates.status.idle');
  }
}

/**
 * "Atualizações" section of the user settings (spec §11.1 item 7): automatic checks on by
 * default, the installed version, and the current state. Mount it in the settings screen.
 */
export function UpdateSettings() {
  const t = useT();
  const state = useUpdateStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const hintId = useId();

  useEffect(() => syncUpdates(window.ghostlink.updates), []);
  if (!state) return null;

  const toggle = () => {
    setBusy(true);
    setError(null);
    window.ghostlink.updates.setAutoCheck(!state.autoCheck).then(
      (next) => {
        useUpdateStore.getState().setState(next);
        setBusy(false);
      },
      (e: unknown) => {
        setError(errorCodeOf(e));
        setBusy(false);
      },
    );
  };
  const restart = () => {
    setError(null);
    window.ghostlink.updates.restart().catch((e: unknown) => setError(errorCodeOf(e)));
  };

  return (
    <section className={styles.section} aria-labelledby={`${hintId}-title`}>
      <h2 id={`${hintId}-title`} className={styles.title}>
        {t('updates.settings.title')}
      </h2>
      <div className={styles.row}>
        <span className={styles.label} id={`${hintId}-label`}>
          {t('updates.settings.autoCheck')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={state.autoCheck}
          aria-labelledby={`${hintId}-label`}
          aria-describedby={hintId}
          className={styles.switch}
          onClick={toggle}
          disabled={busy}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <p id={hintId} className={styles.hint}>
        {t('updates.settings.autoCheckHint')}
      </p>
      <p className={styles.status} aria-live="polite">
        {statusText(t, state)}
      </p>
      <p className={styles.hint}>{t('updates.settings.version', { version: state.currentVersion })}</p>
      {state.status === 'downloaded' && (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={restart}>
            {t('updates.banner.restart')}
          </button>
        </div>
      )}
      <ErrorLine text={error ? errorMessage(t, error) : null} />
    </section>
  );
}
