import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, Circle, ExternalLink, LoaderCircle, X } from 'lucide-react';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { RAILWAY_DEFAULT_REGION, RAILWAY_REGIONS, RAILWAY_STEPS, type RailwayRegion, type ServerEdition } from '../../../shared/railwayTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { ConfirmDialog, Modal, Select, primitives as p } from '../../layout/primitives.js';
import { useSettingsStore } from '../../stores/settings.js';
import { normalizeServerName, normalizeToken, planWarning, wizardView, type StepState } from './railwayModel.js';
import { useRailwayStore, type RailwayRun } from './railwayStore.js';
import r from './railway.module.css';

const TOKENS_URL = 'https://railway.com/account/tokens';

/**
 * "Criar um servidor" → "Na nuvem (Railway)": connect a token, pick the workspace, name and
 * region, then follow the steps until the app joins the new server as its owner. Closing
 * the dialog does not stop a creation (main keeps going; reopening shows the progress).
 */
export function RailwayWizard({ onClose, onJoined }: { onClose: () => void; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const account = useRailwayStore((s) => s.account);
  const pending = useRailwayStore((s) => s.pending);
  const run = useRailwayStore((s) => s.run);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (useRailwayStore.getState().run?.running) return;
    useRailwayStore
      .getState()
      .load()
      .catch((e: unknown) => setLoadError(errorMessage(t, errorCodeOf(e))));
  }, [t]);

  const body = () => {
    switch (wizardView({ run: run !== null, loadError: loadError !== null, account, pending: pending !== null })) {
      case 'progress':
        return <Progress run={run!} onJoined={onJoined} />;
      // A failed load (most often a saved token Railway no longer accepts) is not a dead end: show the
      // connect form with the error as a notice, so the user can enter another token.
      case 'recover':
        return <Connect notice={loadError!} onConnected={() => setLoadError(null)} />;
      case 'loading':
        return <p className={p.text}>{t('railway.loading')}</p>;
      case 'pending':
        return <Pending onJoined={onJoined} />;
      case 'connect':
        return <Connect />;
      default:
        return <Configure onJoined={onJoined} />;
    }
  };

  return (
    <Modal title={t('railway.title')} onClose={onClose} size="medium">
      {body()}
    </Modal>
  );
}

function Connect({ notice, onConnected }: { notice?: string; onConnected?: () => void }) {
  const t = useT();
  const inputId = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const valid = normalizeToken(token);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await useRailwayStore.getState().connect(valid);
      onConnected?.();
    } catch (err) {
      setError(errorMessage(t, errorCodeOf(err)));
      setBusy(false);
    }
  };

  /** Validates the token with Railway without saving it, so the user can confirm it before connecting. */
  const test = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setTested(null);
    try {
      const account = await useRailwayStore.getState().test(valid);
      setTested(t('railway.connect.testOk', { count: account.workspaces.length }));
    } catch (err) {
      setError(errorMessage(t, errorCodeOf(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={r.stack} onSubmit={(e) => void submit(e)}>
      {notice && (
        <p className={p.error} role="alert">
          {notice}
        </p>
      )}
      <p className={p.text}>{notice ? t('railway.connect.recover') : t('railway.connect.lead')}</p>
      <ol className={r.howto}>
        <li>{t('railway.connect.step1')}</li>
        <li>{t('railway.connect.step2')}</li>
        <li>{t('railway.connect.step3')}</li>
      </ol>
      <button type="button" className={`${p.button} ${r.openTokens}`} onClick={() => void window.ghostlink.app.openExternal(TOKENS_URL)}>
        <ExternalLink size={16} aria-hidden="true" />
        {t('railway.connect.open')}
      </button>
      <label className={r.field} htmlFor={inputId}>
        <span className={r.label}>{t('railway.connect.token')}</span>
        <input
          id={inputId}
          className={r.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('railway.connect.placeholder')}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
            setTested(null);
          }}
          disabled={busy}
        />
      </label>
      <p className={r.muted}>{t('railway.connect.privacy')}</p>
      {error && (
        <p className={p.error} role="alert">
          {error}
        </p>
      )}
      {tested && !error && (
        <p className={p.text} role="status">
          {tested}
        </p>
      )}
      <div className={r.actions}>
        <button type="button" className={`${p.button} ${r.testButton}`} disabled={!valid || busy} onClick={() => void test()}>
          {busy ? t('railway.connect.testing') : t('railway.connect.test')}
        </button>
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={!valid || busy}>
          {busy ? t('railway.connect.checking') : t('railway.connect.submit')}
        </button>
      </div>
    </form>
  );
}

function Configure({ onJoined }: { onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const ids = { workspace: useId(), name: useId(), region: useId(), edition: useId() };
  const account = useRailwayStore((s) => s.account)!;
  const nickname = useSettingsStore((s) => s.settings?.nickname ?? '');
  const [workspaceId, setWorkspaceId] = useState(account.workspaces[0]?.id ?? '');
  const [name, setName] = useState(() => t('railway.config.defaultName', { name: nickname }));
  const [region, setRegion] = useState<RailwayRegion>(RAILWAY_DEFAULT_REGION);
  const editionState = useState<ServerEdition>(account.privateServers ? 'private' : 'normal');
  const edition = editionState[0];
  const workspace = account.workspaces.find((w) => w.id === workspaceId) ?? null;
  const warning = workspace ? planWarning(workspace.plan) : null;
  const validName = normalizeServerName(name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!validName || !workspace) return;
    void useRailwayStore.getState().create({ workspaceId: workspace.id, name: validName, region, nickname, edition }, onJoined);
  };

  return (
    <form className={r.stack} onSubmit={submit}>
      <div className={r.account}>
        <span className={r.accountDot} aria-hidden="true" />
        <span className={r.accountText}>{t('railway.config.account')}</span>
        <button type="button" className={r.linkButton} onClick={() => void useRailwayStore.getState().disconnect()}>
          {t('railway.config.changeToken')}
        </button>
      </div>
      {account.workspaces.length > 1 && (
        <div className={r.field}>
          <span id={ids.workspace} className={r.label}>
            {t('railway.config.workspace')}
          </span>
          <Select labelledBy={ids.workspace} value={workspaceId} options={account.workspaces.map((w) => ({ value: w.id, label: w.name }))} onChange={setWorkspaceId} />
        </div>
      )}
      <label className={r.field} htmlFor={ids.name}>
        <span className={r.label}>{t('railway.config.name')}</span>
        <input id={ids.name} className={r.input} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className={r.field}>
        <span id={ids.region} className={r.label}>
          {t('railway.config.region')}
        </span>
        <Select<RailwayRegion>
          labelledBy={ids.region}
          value={region}
          options={RAILWAY_REGIONS.map((id) => ({ value: id, label: t(`railway.region.${id}`) }))}
          onChange={setRegion}
        />
      </div>
      {warning && <p className={`${r.notice} ${r.warning}`}>{t(warning)}</p>}
      <p className={r.notice}>{t('railway.config.voice')}</p>
      <p className={r.muted}>{t('railway.config.cost')}</p>
      <div className={r.actions}>
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={!validName || !workspace}>
          {t('railway.config.submit')}
        </button>
      </div>
    </form>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running') return <LoaderCircle size={18} className={r.spin} aria-hidden="true" />;
  if (state === 'done') return <Check size={18} className={r.done} aria-hidden="true" />;
  if (state === 'failed') return <X size={18} className={r.failed} aria-hidden="true" />;
  return <Circle size={18} className={r.waiting} aria-hidden="true" />;
}

function Progress({ run, onJoined }: { run: RailwayRun; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  return (
    <div className={r.stack}>
      <p className={p.text}>{t('railway.progress.lead', { name: run.name })}</p>
      <ol className={r.steps} aria-label={t('railway.progress.label')}>
        {RAILWAY_STEPS.map((step) => (
          <li key={step} className={`${r.step} ${r[run.steps[step]]}`}>
            <StepIcon state={run.steps[step]} />
            <span>{t(`railway.step.${step}`)}</span>
            <span className={r.visuallyHidden}>{t(`railway.stepState.${run.steps[step]}`)}</span>
          </li>
        ))}
      </ol>
      {run.error && <Failure error={run.error} onJoined={onJoined} />}
    </div>
  );
}

/** After a failure: the reason, then "Tentar de novo" (resume) or delete what was created. */
function Failure({ error, onJoined }: { error: string; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const pending = useRailwayStore((s) => s.pending);
  return (
    <div className={r.failure} role="alert">
      <p className={r.failureTitle}>{t('railway.failed.title')}</p>
      <p className={p.text}>{errorMessage(t, error)}</p>
      {pending && <PendingActions name={pending.name} onJoined={onJoined} />}
    </div>
  );
}

function Pending({ onJoined }: { onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const pending = useRailwayStore((s) => s.pending)!;
  return (
    <div className={r.stack}>
      <p className={p.text}>{t('railway.pending.lead', { name: pending.name, step: t(`railway.step.${pending.step}`) })}</p>
      {pending.error && <p className={p.error}>{errorMessage(t, pending.error)}</p>}
      <PendingActions name={pending.name} resumeLabel={t('railway.pending.resume')} onJoined={onJoined} />
    </div>
  );
}

function PendingActions({ name, resumeLabel, onJoined }: { name: string; resumeLabel?: string; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={r.actions}>
      <button type="button" className={p.button} onClick={() => setConfirming(true)}>
        {t('railway.failed.discard')}
      </button>
      <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => void useRailwayStore.getState().resume(onJoined)}>
        {resumeLabel ?? t('railway.failed.retry')}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t('railway.discard.title', { name })}
          body={t('railway.discard.body')}
          confirmLabel={t('railway.discard.confirm')}
          onConfirm={() => useRailwayStore.getState().discard()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
