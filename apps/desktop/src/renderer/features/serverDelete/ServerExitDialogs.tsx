import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { SavedServer, ServerExitCheck } from '../../../shared/ipcTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { ErrorText, Modal, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useSettingsStore } from '../../stores/settings.js';
import d from './serverDelete.module.css';
import { confirmsServerName, deletionCountdown, deletionMessage, exitDialogStep, offersRemoveOnly } from './serverDeleteModel.js';

/**
 * "Excluir {servidor}?" (spec §3): Discord's red delete modal. The button unlocks only with the
 * server's exact name typed; confirmed, `server.delete` takes it offline for everyone else now.
 */
export function DeleteServerDialog({ name, onDelete, onClose }: { name: string; onDelete: () => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const matches = confirmsServerName(typed, name);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(errorCodeOf(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('serverDelete.title', { name })}
      onClose={onClose}
      initialFocus="input"
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={() => void submit()} disabled={!matches || busy} data-testid="delete-server-confirm">
            {t('serverDelete.confirm')}
          </button>
        </>
      }
    >
      <form className={p.stack} onSubmit={(e) => void submit(e)}>
        <p className={d.notice}>{t('serverDelete.body')}</p>
        <label className={d.field}>
          <span className={d.label}>{t('serverDelete.nameLabel')}</span>
          <input className={d.input} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} maxLength={256} data-testid="delete-server-name" />
        </label>
        {error && <ErrorText code={error} />}
      </form>
    </Modal>
  );
}

/**
 * "Sair de {servidor}?" (spec §2), optionally with all my messages. When the server cannot be
 * reached it says so and offers "Tirar só da minha lista".
 */
export function LeaveServerDialog({
  name,
  onLeave,
  onRemoveOnly,
  onClose,
}: {
  name: string;
  onLeave: (deleteMine: boolean) => Promise<void>;
  onRemoveOnly: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [deleteMine, setDeleteMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const [unreachable, setUnreachable] = useState<AppErrorCode | null>(null);

  if (unreachable !== null) {
    return (
      <RemoveOnlyDialog
        title={t('serverExit.unreachableTitle')}
        text={t('serverExit.unreachableBody', { name, reason: errorMessage(t, unreachable) })}
        onRemoveOnly={onRemoveOnly}
        onClose={onClose}
      />
    );
  }

  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLeave(deleteMine);
      onClose();
    } catch (e) {
      const code = errorCodeOf(e);
      setBusy(false);
      if (offersRemoveOnly(code)) setUnreachable(code);
      else setError(code);
    }
  };

  return (
    <Modal
      title={t('leave.title', { name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={() => void leave()} disabled={busy} data-testid="leave-server-confirm">
            {t('leave.confirm')}
          </button>
        </>
      }
    >
      <div className={p.stack}>
        <p className={p.text}>{t('leave.body')}</p>
        <label className={s.check}>
          <input type="checkbox" checked={deleteMine} onChange={(e) => setDeleteMine(e.target.checked)} />
          <span className={s.hint}>{t('leave.deleteMessages')}</span>
        </label>
        {error && <ErrorText code={error} />}
      </div>
    </Modal>
  );
}

/** The fallback of spec §2: the server does not answer (or no longer exists); only the list can change. */
function RemoveOnlyDialog({ title, text, onRemoveOnly, onClose }: { title: string; text: string; onRemoveOnly: () => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRemoveOnly();
      onClose();
    } catch (e) {
      setError(errorCodeOf(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={() => void remove()} disabled={busy} data-testid="remove-only-confirm">
            {t('serverExit.removeOnly')}
          </button>
        </>
      }
    >
      <div className={p.stack}>
        <p className={p.text}>{text}</p>
        {error && <ErrorText code={error} />}
      </div>
    </Modal>
  );
}

function InfoDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const t = useT();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={onClose}>
          {t('serverExit.close')}
        </button>
      }
    >
      <p className={p.text}>{text}</p>
    </Modal>
  );
}

/**
 * "Sair do servidor" on a saved server that is not open (the Home list's ⋮, the rail's right-click):
 * who owns a server is known only once the app reaches it, so the dialog connects first (a short
 * connection of its own: the open server stays open). A member gets the leave dialog, the owner the
 * delete modal (spec §3: the owner never "leaves"), a server that does not answer the fallback.
 * `onChanged`: the saved list changed (left, deleted from the list, or erased by its owner).
 */
export function ExitServerDialog({ server, onClose, onChanged }: { server: SavedServer; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [check, setCheck] = useState<ServerExitCheck | null>(null);
  const [failure, setFailure] = useState<AppErrorCode | null>(null);
  const api = window.ghostlink;

  useEffect(() => {
    let alive = true;
    api.servers.checkExit(server.id).then(
      (result) => {
        if (!alive) return;
        setCheck(result);
        if (result.kind === 'deleted') onChanged(); // main already took it out of the list
      },
      (e: unknown) => alive && setFailure(errorCodeOf(e)),
    );
    return () => {
      alive = false;
    };
    // Checked once per dialog: `api` and `onChanged` do not restart it.
  }, [server.id]);

  const name = server.name;
  const removeOnly = async () => {
    await api.servers.remove(server.id);
    onChanged();
  };

  if (failure !== null) return <InfoDialog title={t('leave.title', { name })} text={errorMessage(t, failure)} onClose={onClose} />;
  const step = exitDialogStep(check);
  switch (step.step) {
    case 'checking':
      return (
        <Modal
          title={t('leave.title', { name })}
          onClose={onClose}
          footer={
            <button type="button" className={p.button} onClick={onClose}>
              {t('common.cancel')}
            </button>
          }
        >
          <p className={d.checking} role="status">
            <LoaderCircle className={d.spin} size={18} aria-hidden="true" />
            {t('serverExit.checking', { name })}
          </p>
        </Modal>
      );
    case 'leave':
      return (
        <LeaveServerDialog
          name={name}
          onLeave={async (deleteMine) => {
            await api.servers.leave(server.id, deleteMine);
            onChanged();
          }}
          onRemoveOnly={removeOnly}
          onClose={onClose}
        />
      );
    case 'delete':
      return (
        <DeleteServerDialog
          name={step.name}
          onDelete={async () => {
            await api.servers.delete(server.id);
          }}
          onClose={onClose}
        />
      );
    case 'ownerCannot':
      return <InfoDialog title={t('serverExit.delete')} text={t('serverExit.ownerCannot', { name })} onClose={onClose} />;
    case 'ownerDeleting': {
      const left = deletionCountdown(step.at, Date.now());
      return <InfoDialog title={t('serverDelete.bannerLabel')} text={t('serverExit.ownerDeleting', { name, time: t(left.key, left.vars) })} onClose={onClose} />;
    }
    case 'deleting': {
      const message = deletionMessage('SERVER_DELETING', name, step.at, locale)!;
      return <RemoveOnlyDialog title={t(message.title)} text={t(message.text, message.vars)} onRemoveOnly={removeOnly} onClose={onClose} />;
    }
    case 'deleted':
      return <InfoDialog title={t('serverDelete.deletedTitle')} text={t('serverDelete.deleted', { name })} onClose={onClose} />;
    case 'unreachable':
      return (
        <RemoveOnlyDialog
          title={t('serverExit.unreachableTitle')}
          text={t('serverExit.unreachableBody', { name, reason: errorMessage(t, step.code) })}
          onRemoveOnly={removeOnly}
          onClose={onClose}
        />
      );
  }
}
