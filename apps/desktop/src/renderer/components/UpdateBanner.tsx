import { useEffect, useState } from 'react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import { bannerFor, syncUpdates, useUpdateStore } from '../features/updates/store.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import styles from './UpdateBanner.module.css';

// 24×24 stroke icons in the style of the app's icon set (lucide geometry, ISC).
const ICONS = {
  download: ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'],
  restart: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  shield: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'M12 8v4',
    'M12 16h.01',
  ],
} as const;

function Icon({ name, size }: { name: keyof typeof ICONS; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * Spec §15 notice, mounted once above every screen: "Nova versão X baixada — Reiniciar para
 * atualizar" once a verified update is ready, or a warning when a download failed the Ed25519
 * release-signature check (it was deleted and nothing was installed). A floating card in the
 * main screen's visual language: bordered, rounded, icon tile, blurple action.
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
        <div className={styles.body}>
          <span className={styles.tile}>
            <Icon name="shield" size={18} />
          </span>
          <div className={styles.text}>
            <p className={styles.title}>{t('updates.banner.rejected', { version: banner.version })}</p>
            <p className={styles.hint}>{t('updates.banner.rejectedHint')}</p>
          </div>
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
      <div className={styles.body}>
        <span className={styles.tile}>
          <Icon name="download" size={18} />
        </span>
        <div className={styles.text}>
          <p className={styles.title}>{t('updates.banner.downloaded', { version: banner.version })}</p>
          <p className={error ? `${styles.hint} ${styles.error}` : styles.hint}>
            {error ? errorMessage(t, error) : t('updates.banner.downloadedHint')}
          </p>
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={dismiss} disabled={busy}>
          {t('updates.banner.later')}
        </button>
        <button type="button" className={styles.primary} onClick={restart} disabled={busy} aria-busy={busy}>
          <Icon name="restart" size={16} />
          {t('updates.banner.restart')}
        </button>
      </div>
    </section>
  );
}
