import { useEffect, useState } from 'react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import { bannerFor, syncUpdates, useUpdateStore } from '../features/updates/store.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import styles from './UpdateBanner.module.css';

/**
 * Spec §15 notice, mounted once above every screen: "Nova versão X baixada — Reiniciar para
 * atualizar" once a verified update is ready, or a warning when a download failed the Ed25519
 * release-signature check (it was deleted and nothing was installed).
 */
export function UpdateBanner() {
  const t = useT();
  const state = useUpdateStore((s) => s.state);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);

  useEffect(() => syncUpdates(window.ghostlink.updates), []);

  const banner = bannerFor(state, dismissed);
  if (!banner) return null;
  const dismiss = () => useUpdateStore.getState().dismiss();

  if (banner.kind === 'rejected') {
    return (
      <section className={`${styles.banner} ${styles.rejected}`} role="alert" aria-label={t('updates.banner.label')}>
        <div className={styles.text}>
          <p className={styles.title}>{t('updates.banner.rejected', { version: banner.version })}</p>
          <p className={styles.hint}>{t('updates.banner.rejectedHint')}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={dismiss}>
            {t('updates.banner.dismiss')}
          </button>
        </div>
      </section>
    );
  }

  const restart = () => {
    setBusy(true);
    setError(null);
    window.ghostlink.updates.restart().catch((e: unknown) => {
      setError(errorCodeOf(e));
      setBusy(false);
    });
  };
  return (
    <section className={styles.banner} role="status" aria-label={t('updates.banner.label')}>
      <div className={styles.text}>
        <p className={styles.title}>{t('updates.banner.downloaded', { version: banner.version })}</p>
        <p className={styles.hint}>{error ? errorMessage(t, error) : t('updates.banner.downloadedHint')}</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={dismiss} disabled={busy}>
          {t('updates.banner.later')}
        </button>
        <button type="button" className={styles.primary} onClick={restart} disabled={busy}>
          {t('updates.banner.restart')}
        </button>
      </div>
    </section>
  );
}
