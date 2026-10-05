import { CircleAlert, CircleArrowDown, CircleCheck, LoaderCircle, ShieldAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { markdown as bundledMarkdown, version as bundledVersion } from 'virtual:ghostlink/release-notes';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { Locale } from '../../../shared/ipcTypes.js';
import type { ReleaseNotesResult, UpdateState } from '../../../shared/updates.js';
import { ErrorLine } from '../../components/Screen.js';
import { DEFAULT_LOCALE, errorCodeOf, errorMessage, useT, type Translate } from '../../i18n/index.js';
import { primitives as p } from '../../layout/primitives.js';
import { useSettingsStore } from '../../stores/settings.js';
import { ReleaseNotesSection, type NotesView } from './ReleaseNotesSection.js';
import { releaseChanges } from './releaseNotes.js';
import { syncUpdates, useUpdateStore } from './store.js';
import { checkFailed, lastCheckedText, updatePageModel, type UpdateStatusView } from './updatePage.js';
import styles from './UpdateSettings.module.css';

/**
 * "Atualizações" in the user settings (spec §11.1 item 7, v0.2.3): the installed version and
 * "Procurar atualizações", the state of the updater ("Baixando a 0.2.3… 42%", "Atualizar e
 * reiniciar"…), the automatic checks (on by default), and what is new: in the version found, and
 * in the installed one.
 */
export function UpdateSettings() {
  const state = useUpdateStore((s) => s.state);
  useEffect(() => syncUpdates(window.ghostlink.updates), []);
  return state ? <UpdatesPage state={state} /> : null;
}

function UpdatesPage({ state }: { state: UpdateState }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? DEFAULT_LOCALE);
  const [toggling, setToggling] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The lastCheckedAt a click of "Procurar" ended on without an answer: failed until a newer one comes. */
  const [failedOn, setFailedOn] = useState<{ lastCheckedAt: number | null } | null>(null);
  /** Bumped after each "Procurar": notes that failed may have loaded since. */
  const [round, setRound] = useState(0);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const id = useId();

  const model = updatePageModel(state, failedOn !== null && failedOn.lastCheckedAt === state.lastCheckedAt);
  const newNotes = useFoundNotes(model.newVersion, round, locale);
  const installed = useMemo(() => installedNotes(state.currentVersion, locale), [state.currentVersion, locale]);

  const toggle = () => {
    setToggling(true);
    setError(null);
    window.ghostlink.updates.setAutoCheck(!state.autoCheck).then(
      (next) => {
        useUpdateStore.getState().setState(next);
        setToggling(false);
      },
      (e: unknown) => {
        setError(errorCodeOf(e));
        setToggling(false);
      },
    );
  };
  const check = () => {
    const before = state;
    setChecking(true);
    setFailedOn(null);
    setError(null);
    window.ghostlink.updates.checkNow().then(
      (next) => {
        useUpdateStore.getState().setState(next);
        setFailedOn(checkFailed(before, next) ? { lastCheckedAt: next.lastCheckedAt } : null);
        setChecking(false);
        setRound((r) => r + 1);
      },
      (e: unknown) => {
        setError(errorCodeOf(e));
        setChecking(false);
      },
    );
  };
  const restart = () => {
    setError(null);
    window.ghostlink.updates.restart().catch((e: unknown) => setError(errorCodeOf(e)));
  };

  const busy = checking || model.status.kind === 'checking';
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.title}>
        {t('updates.settings.title')}
      </h2>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <p className={styles.version}>{versionLine(t, state.currentVersion)}</p>
          {model.showCheck && (
            <button type="button" className={p.button} onClick={check} disabled={!model.canCheck || busy}>
              {busy && <LoaderCircle size={16} className={`${styles.checkIcon} ${styles.spin}`} aria-hidden="true" />}
              {t(busy ? 'updates.page.checking' : 'updates.page.checkNow')}
            </button>
          )}
        </div>
        <Status t={t} locale={locale} status={model.status} />
        {model.status.kind === 'downloading' && (
          <div
            className={styles.progress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={model.status.percent}
            aria-label={t('updates.page.progress', { version: model.status.version })}
          >
            <div className={styles.progressFill} style={{ width: `${model.status.percent}%` }} />
          </div>
        )}
        {model.status.kind === 'downloaded' && (
          <div className={styles.actions}>
            <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={restart}>
              {t('updates.page.restart')}
            </button>
          </div>
        )}
        <ErrorLine text={error ? errorMessage(t, error) : null} />
      </div>

      <div className={styles.row}>
        <span className={styles.label} id={`${id}-label`}>
          {t('updates.settings.autoCheck')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={state.autoCheck}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          className={styles.switch}
          onClick={toggle}
          disabled={toggling}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        {t('updates.settings.autoCheckHint')}
      </p>

      {model.newVersion !== null && (
        <ReleaseNotesSection title={t('updates.page.newNotes', { version: model.newVersion })} version={model.newVersion} view={newNotes} fresh />
      )}
      <ReleaseNotesSection
        title={t('updates.page.installedNotes', { version: state.currentVersion })}
        version={state.currentVersion}
        view={installed}
      />
    </section>
  );
}

/** "Versão instalada: 0.8.3" (the About line). */
function versionLine(t: Translate, version: string): string {
  return t('updates.settings.version', { version });
}

// No icon while checking: the button already spins.
const STATUS_ICON: Partial<Record<UpdateStatusView['kind'], { Icon: LucideIcon; tone: string | undefined }>> = {
  upToDate: { Icon: CircleCheck, tone: styles.statusOk },
  checkFailed: { Icon: CircleAlert, tone: styles.statusWarn },
  downloading: { Icon: CircleArrowDown, tone: styles.statusNew },
  downloaded: { Icon: CircleArrowDown, tone: styles.statusNew },
  rejected: { Icon: ShieldAlert, tone: styles.statusBad },
};

/** The status in one strong line, and a quieter one under it. */
function statusLines(t: Translate, locale: Locale, status: UpdateStatusView): [line: string | null, hint: string | null] {
  switch (status.kind) {
    case 'unsupported':
      return [null, t('updates.settings.unsupported')];
    case 'disabled':
      return [t('updates.status.disabled'), null];
    case 'idle':
      return [t('updates.status.idle'), null];
    case 'checking':
      return [t('updates.status.checking'), null];
    case 'checkFailed':
      return [t('updates.status.checkFailed'), null];
    case 'upToDate':
      return [t('updates.status.upToDate'), lastCheckedText(t, locale, status.checkedAt)];
    case 'downloading':
      return [t('updates.status.downloading', { version: status.version, percent: status.percent }), t('updates.page.downloadingHint')];
    case 'downloaded':
      return [t('updates.status.downloaded', { version: status.version }), t('updates.page.downloadedHint')];
    case 'rejected':
      return [t('updates.banner.rejected', { version: status.version }), t('updates.banner.rejectedHint')];
  }
}

function Status({ t, locale, status }: { t: Translate; locale: Locale; status: UpdateStatusView }) {
  const [line, hint] = statusLines(t, locale, status);
  const icon = STATUS_ICON[status.kind];
  return (
    <div className={styles.status} aria-live="polite">
      {icon && <icon.Icon size={18} className={[styles.statusIcon, icon.tone].filter(Boolean).join(' ')} aria-hidden="true" />}
      <div className={styles.statusText}>
        {line && <p className={styles.statusLine}>{line}</p>}
        {hint && <p className={styles.statusHint}>{hint}</p>}
      </div>
    </div>
  );
}

/** The installed version's notes, bundled at build time (no request). */
function installedNotes(currentVersion: string, locale: Locale): NotesView {
  if (bundledMarkdown === null || bundledVersion !== currentVersion) return { kind: 'missing' };
  const items = releaseChanges(bundledMarkdown, locale);
  return items === null ? { kind: 'missing' } : { kind: 'ready', items };
}

/** The found version's notes, as main fetched them; asked again after each "Procurar". */
function useFoundNotes(version: string | null, round: number, locale: Locale): NotesView {
  const [answer, setAnswer] = useState<{ key: string; notes: ReleaseNotesResult } | null>(null);
  useEffect(() => {
    if (version === null) return;
    let alive = true;
    const key = `${version}#${round}`;
    window.ghostlink.updates.notes(version).then(
      (notes) => alive && setAnswer({ key, notes }),
      () => alive && setAnswer({ key, notes: { version, status: 'unavailable' } }),
    );
    return () => {
      alive = false;
    };
  }, [version, round]);
  const notes = answer?.notes ?? null;
  return useMemo((): NotesView => {
    // Until the new round answers, the last answer for this version stays on screen.
    if (version === null || notes === null || notes.version !== version) return { kind: 'loading' };
    if (notes.status === 'unavailable') return { kind: 'unavailable' };
    const items = releaseChanges(notes.markdown, locale);
    return items === null ? { kind: 'missing' } : { kind: 'ready', items };
  }, [version, notes, locale]);
}
