import { useState, type FormEvent } from 'react';
import { CHAT_LIMITS, type JoinMode } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useTextStore } from '../../stores/text.js';
import { updateServer, type ServerPatch } from '../chat/actions.js';
import { useOpenServerExit } from '../serverDelete/DeletionBanner.js';
import d from '../serverDelete/serverDelete.module.css';
import { DeleteServerDialog } from '../serverDelete/ServerExitDialogs.js';
import { ServerIconSection } from './ServerIconSection.js';

const MODES: JoinMode[] = ['invite', 'password', 'open'];

/** The icon, name, who can join (with the password) and the member limit (MANAGE_SERVER). */
export function OverviewTab() {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const [name, setName] = useState(server.name);
  const [joinMode, setJoinMode] = useState<JoinMode>(server.joinMode);
  const [password, setPassword] = useState('');
  const [maxMembers, setMaxMembers] = useState(server.maxMembers || 100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const needsPassword = joinMode === 'password' && !server.hasPassword && password === '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsPassword) return;
    const patch: ServerPatch = {};
    if (name.trim() !== server.name) patch.name = name.trim();
    if (joinMode !== server.joinMode) patch.joinMode = joinMode;
    if (password !== '') patch.password = password;
    if (maxMembers !== server.maxMembers) patch.maxMembers = maxMembers;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (Object.keys(patch).length > 0) await updateServer(patch);
      setPassword('');
      setSaved(true);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ServerIconSection />
      <form className={s.form} onSubmit={(e) => void submit(e)}>
        <label className={s.field}>
          <span className={s.label}>{t('serverSettings.overview.name')}</span>
          <input className={s.input} value={name} maxLength={CHAT_LIMITS.serverNameMax} onChange={(e) => setName(e.target.value)} required />
        </label>
        <fieldset className={s.field} style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className={s.label}>{t('serverSettings.overview.joinMode')}</legend>
          <div className={s.radioGroup}>
            {MODES.map((mode) => (
              <label key={mode} className={s.choice}>
                <input type="radio" name="joinMode" checked={joinMode === mode} onChange={() => setJoinMode(mode)} />
                <span className={s.choiceText}>
                  <span className={s.choiceTitle}>{t(`serverSettings.overview.mode.${mode}`)}</span>
                  <span className={s.hint}>{t(`serverSettings.overview.modeHint.${mode}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {(joinMode === 'password' || server.hasPassword) && (
          <label className={s.field}>
            <span className={s.label}>{t('serverSettings.overview.password')}</span>
            <input
              className={s.input}
              type="password"
              value={password}
              maxLength={CHAT_LIMITS.passwordMax}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className={s.hint}>{server.hasPassword ? t('serverSettings.overview.passwordSet') : t('serverSettings.overview.passwordHint')}</span>
          </label>
        )}
        <label className={s.field}>
          <span className={s.label}>{t('serverSettings.overview.maxMembers')}</span>
          <input
            className={s.input}
            type="number"
            min={1}
            max={CHAT_LIMITS.maxMembersLimit}
            value={maxMembers}
            onChange={(e) => setMaxMembers(Math.max(1, Math.min(CHAT_LIMITS.maxMembersLimit, Math.trunc(Number(e.target.value) || 1))))}
          />
        </label>
        {needsPassword && <p className={s.warning}>{t('serverSettings.overview.passwordRequired')}</p>}
        {error && <ErrorText code={error} />}
        {saved && <p className={s.ok}>{t('serverSettings.saved')}</p>}
        <div className={s.row}>
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || needsPassword || name.trim() === ''}>
            {t('serverSettings.save')}
          </button>
        </div>
      </form>
      <DangerZone />
    </>
  );
}

/** Leave/delete spec §3: "Excluir servidor" for the owner, on a server that can delete itself. */
function DangerZone() {
  const t = useT();
  const exit = useOpenServerExit();
  const serverId = useTextStore((st) => st.server.serverId);
  const name = useTextStore((st) => st.server.name);
  const [deleting, setDeleting] = useState(false);
  if (exit !== 'delete' || serverId === null) return null;
  return (
    <section className={d.danger} aria-labelledby="danger-zone">
      <h3 id="danger-zone" className={d.dangerTitle}>
        {t('serverDelete.dangerZone')}
      </h3>
      <div className={d.dangerRow}>
        <p className={d.dangerHint}>{t('serverDelete.dangerHint')}</p>
        <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={() => setDeleting(true)}>
          {t('serverExit.delete')}
        </button>
      </div>
      {deleting && (
        <DeleteServerDialog
          name={name}
          onDelete={async () => {
            await window.ghostlink.servers.delete(serverId);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </section>
  );
}
