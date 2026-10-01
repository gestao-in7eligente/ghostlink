import { useEffect, useState, type FormEvent } from 'react';
import { ATTACHMENT_LIMITS, CHAT_LIMITS, FEATURE_ATTACHMENTS, MB, type JoinMode, type ServerStorage } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useConnectionStore } from '../../stores/connection.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { formatSize } from '../attachments/attachmentModel.js';
import a from '../attachments/attachments.module.css';
import { serverStorage, updateServer, type ServerPatch } from '../chat/actions.js';
import { useOpenServerExit } from '../serverDelete/DeletionBanner.js';
import d from '../serverDelete/serverDelete.module.css';
import { DeleteServerDialog } from '../serverDelete/ServerExitDialogs.js';

const MODES: JoinMode[] = ['invite', 'password', 'open'];
const { uploadLimitMb: UPLOAD, storageQuotaMb: QUOTA } = ATTACHMENT_LIMITS;

/** A whole number of MB within the server's bounds (a blank or odd field falls back to the lowest). */
function clampMb(value: string, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.trunc(Number(value) || bounds.min)));
}

/** Name, who can join (with the password), the member limit and the file limits (MANAGE_SERVER). */
export function OverviewTab() {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const [name, setName] = useState(server.name);
  const [joinMode, setJoinMode] = useState<JoinMode>(server.joinMode);
  const [password, setPassword] = useState('');
  const [maxMembers, setMaxMembers] = useState(server.maxMembers || 100);
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const takesFiles = useConnectionStore((st) => st.welcome?.serverId === server.serverId && st.welcome.features.includes(FEATURE_ATTACHMENTS));
  const [uploadLimitMb, setUploadLimitMb] = useState(server.uploadLimitMb);
  const [storageQuotaMb, setStorageQuotaMb] = useState(server.storageQuotaMb);
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
    if (takesFiles && uploadLimitMb !== server.uploadLimitMb) patch.uploadLimitMb = uploadLimitMb;
    if (takesFiles && storageQuotaMb !== server.storageQuotaMb) patch.storageQuotaMb = storageQuotaMb;
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
        {takesFiles && (
          <section className={a.filesSection} aria-labelledby="overview-files">
            <h3 id="overview-files" className={a.filesTitle}>
              {t('serverSettings.overview.files')}
            </h3>
            <div className={a.filesRow}>
              <label className={s.field}>
                <span className={s.label}>{t('serverSettings.overview.uploadLimit')}</span>
                <input
                  className={s.input}
                  type="number"
                  min={UPLOAD.min}
                  max={UPLOAD.max}
                  value={uploadLimitMb}
                  onChange={(e) => setUploadLimitMb(clampMb(e.target.value, UPLOAD))}
                />
              </label>
              <label className={s.field}>
                <span className={s.label}>{t('serverSettings.overview.storageQuota')}</span>
                <input
                  className={s.input}
                  type="number"
                  min={QUOTA.min}
                  max={QUOTA.max}
                  value={storageQuotaMb}
                  onChange={(e) => setStorageQuotaMb(clampMb(e.target.value, QUOTA))}
                />
              </label>
            </div>
            <p className={s.hint}>
              {t('serverSettings.overview.uploadLimitHint', { max: UPLOAD.max })} {t('serverSettings.overview.storageQuotaHint', { size: formatSize(storageQuotaMb * MB, locale) })}
            </p>
            <StorageUse quotaMb={server.storageQuotaMb} />
          </section>
        )}
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

/** The space attachments use, against the quota the server has now (`server.storage`). */
function StorageUse({ quotaMb }: { quotaMb: number }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [storage, setStorage] = useState<ServerStorage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    serverStorage().then(
      (value) => live && setStorage(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [quotaMb]);
  if (failed) return <p className={s.hint}>{t('serverSettings.overview.storageError')}</p>;
  if (storage === null) return <p className={s.hint}>{t('serverSettings.overview.storageLoading')}</p>;
  const total = quotaMb * MB;
  const share = total > 0 ? Math.min(1, storage.usedBytes / total) : 1;
  const full = storage.usedBytes >= total;
  return (
    <div className={a.storage} data-storage>
      <span className={a.storageText}>{t('serverSettings.overview.storageUsed', { used: formatSize(storage.usedBytes, locale), total: formatSize(total, locale) })}</span>
      <span
        className={a.storageBar}
        role="meter"
        aria-label={t('serverSettings.overview.storageQuota')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(storage.usedBytes, total)}
      >
        <span className={full ? `${a.storageFill} ${a.storageFull}` : a.storageFill} style={{ width: `${Math.max(share * 100, storage.usedBytes > 0 ? 1 : 0)}%` }} />
      </span>
      {full && <span className={s.hint}>{t('serverSettings.overview.storageFull')}</span>}
    </div>
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
