import { useEffect, useRef, useState } from 'react';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { HostStartResult } from '../../../shared/hostTypes.js';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { ErrorLine } from '../../components/Screen.js';
import ui from '../../components/ui.module.css';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { HostDialog } from './HostDialog.js';
import { HostNetworkCard } from './HostNetworkCard.js';
import host from './host.module.css';
import {
  INVITE_EXPIRY_CHOICES,
  INVITE_USES_CHOICES,
  inviteOptions,
  type InviteExpiryChoice,
  type InviteUsesChoice,
} from './hostFormModel.js';
import { useHostStore } from './hostStore.js';

const POLL_MS = 2_000;

/**
 * spec §11.1 screen 3 (panel), as a modal: the invite with a copy button (webLink),
 * the fingerprint, members and ownership, the addresses, the logs, and stop/restart.
 */
export function HostPanel({
  onClose,
  onJoined,
  onHostAnother,
}: {
  onClose: () => void;
  onJoined: (welcome: RendererWelcome) => void;
  onHostAnother: () => void;
}) {
  const t = useT();
  const status = useHostStore((s) => s.status);
  const logs = useHostStore((s) => s.logs);
  const dispatch = useHostStore((s) => s.dispatch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [expiry, setExpiry] = useState<InviteExpiryChoice>('168');
  const [uses, setUses] = useState<InviteUsesChoice>('unlimited');
  const logsRef = useRef<HTMLPreElement>(null);
  const api = window.ghostlink;

  // While the panel is open: members, addresses and logs stay fresh.
  useEffect(() => {
    let alive = true;
    const poll = () => {
      void api.host.status().then((s) => alive && dispatch({ type: 'status', status: s }), () => {});
      void api.host.logs().then((lines) => alive && dispatch({ type: 'logs', lines }), () => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, dispatch]);

  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

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

  const joinedFrom = (result: HostStartResult) => {
    dispatch({ type: 'status', status: result.status });
    if (result.welcome) onJoined(result.welcome);
  };

  const copy = (text: string, what: 'link' | 'code') =>
    run(async () => {
      await api.host.copyText(text);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 2_000);
    });

  if (status === null) {
    return (
      <HostDialog title={t('host.panel.title')} closeLabel={t('host.dialog.close')} onClose={onClose} wide>
        <p className={ui.hint}>{t('app.loading')}</p>
      </HostDialog>
    );
  }

  const running = status.state === 'running';
  const transitioning = status.state === 'starting' || status.state === 'stopping';
  const dotClass = running ? `${host.live} ${host.liveOn}` : status.state === 'failed' ? `${host.live} ${host.liveBad}` : host.live;
  const stateText = running && status.port !== null ? t('host.state.running', { port: status.port }) : t(`host.state.${status.state}`);
  const statePill = (
    <span className={host.pill} role="status">
      <span className={dotClass} aria-hidden="true" />
      {stateText}
    </span>
  );

  return (
    <HostDialog title={status.config?.name ?? t('host.panel.title')} status={statePill} closeLabel={t('host.dialog.close')} onClose={onClose} wide>
      {status.state === 'failed' && (
        <ErrorLine
          text={
            status.error === 'PORT_IN_USE' && status.errorPort !== null
              ? t('host.form.portInUse', { port: status.errorPort })
              : t('host.panel.failed')
          }
        />
      )}
      {status.state === 'stopped' && <p className={ui.text}>{t('host.panel.stopped')}</p>}

      {running && status.joinError && (
        <div className={host.row}>
          <p className={`${ui.warning} ${host.grow}`}>{t('host.panel.joinFailed', { reason: errorMessage(t, status.joinError) })}</p>
          <button type="button" className={ui.button} disabled={busy} onClick={() => void run(async () => joinedFrom(await api.host.join()))}>
            {t('host.panel.open')}
          </button>
        </div>
      )}

      {running && (
        <section className={host.card} aria-labelledby="host-invite">
          <h2 id="host-invite" className={host.cardTitle}>
            {t('host.panel.invite')}
          </h2>
          <p className={ui.hint}>{t('host.panel.inviteHint')}</p>
          {status.invite && (
            <>
              <input
                className={`${ui.input} ${host.inviteLink}`}
                value={status.invite.webLink}
                readOnly
                aria-label={t('host.panel.invite')}
                onFocus={(e) => e.target.select()}
              />
              <div className={host.row}>
                <button type="button" className={`${ui.button} ${ui.primary}`} disabled={busy} onClick={() => void copy(status.invite!.webLink, 'link')}>
                  {copied === 'link' ? t('host.panel.copied') : t('host.panel.copy')}
                </button>
                <button type="button" className={ui.button} disabled={busy} onClick={() => void copy(status.invite!.pasteCode, 'code')}>
                  {copied === 'code' ? t('host.panel.copied') : t('host.panel.copyCode')}
                </button>
              </div>
            </>
          )}
          <div className={host.row}>
            <label className={`${ui.field} ${host.grow}`}>
              <span className={ui.label}>{t('host.panel.expires')}</span>
              <select className={ui.input} value={expiry} onChange={(e) => setExpiry(e.target.value as InviteExpiryChoice)}>
                {INVITE_EXPIRY_CHOICES.map((c) => (
                  <option key={c} value={c}>
                    {t(`host.panel.expires.${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${ui.field} ${host.grow}`}>
              <span className={ui.label}>{t('host.panel.uses')}</span>
              <select className={ui.input} value={uses} onChange={(e) => setUses(e.target.value as InviteUsesChoice)}>
                {INVITE_USES_CHOICES.map((c) => (
                  <option key={c} value={c}>
                    {t(`host.panel.uses.${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={status.invite ? ui.button : `${ui.button} ${ui.primary}`}
              disabled={busy}
              onClick={() => void run(async () => void (await api.host.invite(inviteOptions(expiry, uses))))}
            >
              {t('host.panel.createInvite')}
            </button>
          </div>
        </section>
      )}

      {running && <HostNetworkCard status={status} />}

      {(status.fingerprint || (running && status.members !== null)) && (
        <div className={host.cards2}>
          {status.fingerprint && (
            <section className={host.card} aria-labelledby="host-fingerprint">
              <h2 id="host-fingerprint" className={host.cardTitle}>
                {t('host.panel.fingerprint')}
              </h2>
              <p className={host.fingerprint}>
                {/* Wraps between pairs of groups, never inside one. */}
                <span>{status.fingerprint.split(' ').slice(0, 2).join(' ')}</span> <span>{status.fingerprint.split(' ').slice(2).join(' ')}</span>
              </p>
              <span className={ui.hint}>{t('host.panel.fingerprintHint')}</span>
            </section>
          )}
          {running && status.members !== null && status.maxMembers !== null && (
            <section className={host.card} aria-labelledby="host-members">
              <h2 id="host-members" className={host.cardTitle}>
                {t('host.panel.members')}
              </h2>
              <p className={host.bigNumber}>{t('host.panel.membersCount', { members: status.members, max: status.maxMembers })}</p>
              <span className={ui.hint}>{status.hasOwner ? t('host.panel.owner') : t('host.panel.noOwner')}</span>
              <button
                type="button"
                className={ui.button}
                disabled={busy}
                title={t('host.panel.recoverHint')}
                onClick={() => void run(async () => joinedFrom(await api.host.recoverOwnership()))}
              >
                {t('host.panel.recover')}
              </button>
            </section>
          )}
        </div>
      )}

      {status.addresses.length > 0 && (
        <section className={host.card} aria-labelledby="host-addresses">
          <h2 id="host-addresses" className={host.cardTitle}>
            {t('host.panel.addresses')}
          </h2>
          <ul className={host.addresses}>
            {status.addresses.map((a) => (
              <li key={a.address} className={host.address}>
                <span className={host.addressValue}>{a.address}</span>
                <span className={host.addressKind}>{t(`host.address.${a.kind}`)}</span>
              </li>
            ))}
          </ul>
          {status.port !== null && <span className={ui.hint}>{t('host.panel.addressesHint', { port: status.port })}</span>}
        </section>
      )}

      <section className={host.card} aria-labelledby="host-logs">
        <h2 id="host-logs" className={host.cardTitle}>
          {t('host.panel.logs')}
        </h2>
        <pre ref={logsRef} className={host.logs} tabIndex={0}>
          {logs.length > 0 ? logs.join('\n') : t('host.panel.logsEmpty')}
        </pre>
      </section>

      <ErrorLine text={error && errorMessage(t, error)} />
      {confirmStop && <p className={ui.warning}>{t('host.panel.stopConfirm')}</p>}
      <div className={host.footer}>
        {confirmStop ? (
          <>
            <button type="button" className={ui.button} onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={`${ui.button} ${ui.danger}`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setConfirmStop(false);
                  dispatch({ type: 'status', status: await api.host.stop() });
                })
              }
            >
              {t('host.panel.stopConfirmButton')}
            </button>
          </>
        ) : running || transitioning ? (
          <>
            <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy || transitioning} onClick={() => setConfirmStop(true)}>
              {t('host.panel.stop')}
            </button>
            <button type="button" className={ui.button} disabled={busy || transitioning} onClick={() => void run(async () => joinedFrom(await api.host.restart()))}>
              {t('host.panel.restart')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={ui.button} disabled={busy} onClick={onHostAnother}>
              {t('host.panel.hostAnother')}
            </button>
            {status.config && (
              <button
                type="button"
                className={`${ui.button} ${ui.primary}`}
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    joinedFrom(status.state === 'failed' ? await api.host.restart() : await api.host.start(status.config!)),
                  )
                }
              >
                {t('host.panel.startAgain')}
              </button>
            )}
          </>
        )}
        <button type="button" className={ui.button} onClick={onClose}>
          {t('host.dialog.close')}
        </button>
      </div>
    </HostDialog>
  );
}
