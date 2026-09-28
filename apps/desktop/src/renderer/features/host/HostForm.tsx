import { useState, type FormEvent } from 'react';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { HostJoinMode, HostStartResult } from '../../../shared/hostTypes.js';
import { ErrorLine } from '../../components/Screen.js';
import ui from '../../components/ui.module.css';
import { errorCodeOf, errorMessage, useT, type MessageKey } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { HostDialog } from './HostDialog.js';
import host from './host.module.css';
import { HOST_NAME_MAX_LENGTH, initialHostForm, validateHostForm, type HostFormField } from './hostFormModel.js';
import { useHostStore } from './hostStore.js';

const FIELD_ERROR: Record<HostFormField, MessageKey> = {
  name: 'host.form.invalid.name',
  port: 'host.form.invalid.port',
  maxMembers: 'host.form.invalid.maxMembers',
};

/**
 * spec §11.1 screen 3, as a modal: name, port, join mode and member limit → the
 * server starts in a utility process and the app joins it as the owner.
 */
export function HostForm({ onCancel, onStarted }: { onCancel: () => void; onStarted: (result: HostStartResult) => void }) {
  const t = useT();
  const nickname = useSettingsStore((s) => s.settings?.nickname ?? '');
  const last = useHostStore((s) => s.status?.config ?? null);
  const [form, setForm] = useState(() => initialHostForm(last, t('host.form.defaultName', { nickname })));
  const [invalid, setInvalid] = useState<HostFormField | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: AppErrorCode; port: number | null } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const checked = validateHostForm(form);
    if (!checked.ok) {
      setInvalid(checked.field);
      return;
    }
    setInvalid(null);
    setError(null);
    setBusy(true);
    try {
      const result = await window.ghostlink.host.start(checked.config);
      if (result.status.state === 'failed') setError({ code: result.status.error ?? 'HOST_FAILED', port: result.status.errorPort });
      else onStarted(result);
    } catch (e) {
      setError({ code: errorCodeOf(e), port: null });
    } finally {
      setBusy(false);
    }
  };

  const errorText =
    error === null ? null : error.code === 'PORT_IN_USE' && error.port !== null ? t('host.form.portInUse', { port: error.port }) : errorMessage(t, error.code);

  return (
    <HostDialog title={t('host.form.title')} closeLabel={t('host.dialog.close')} onClose={onCancel}>
      <p className={ui.text}>{t('host.form.intro')}</p>
      <form className={ui.form} onSubmit={(e) => void submit(e)} noValidate>
        <label className={ui.field}>
          <span className={ui.label}>{t('host.form.name')}</span>
          <input
            className={ui.input}
            value={form.name}
            maxLength={HOST_NAME_MAX_LENGTH}
            autoFocus
            disabled={busy}
            aria-invalid={invalid === 'name'}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <span className={ui.hint}>{t('host.form.sameName')}</span>
        </label>
        <div className={host.twoColumns}>
          <label className={ui.field}>
            <span className={ui.label}>{t('host.form.port')}</span>
            <input
              className={ui.input}
              value={form.port}
              inputMode="numeric"
              maxLength={5}
              disabled={busy}
              aria-invalid={invalid === 'port'}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </label>
          <label className={ui.field}>
            <span className={ui.label}>{t('host.form.maxMembers')}</span>
            <input
              className={ui.input}
              value={form.maxMembers}
              inputMode="numeric"
              maxLength={5}
              disabled={busy}
              aria-invalid={invalid === 'maxMembers'}
              onChange={(e) => setForm({ ...form, maxMembers: e.target.value })}
            />
          </label>
        </div>
        <span className={ui.hint}>{t('host.form.portHint')}</span>
        <label className={ui.field}>
          <span className={ui.label}>{t('host.form.joinMode')}</span>
          <select
            className={ui.input}
            value={form.joinMode}
            disabled={busy}
            onChange={(e) => setForm({ ...form, joinMode: e.target.value as HostJoinMode })}
          >
            <option value="invite">{t('host.form.joinMode.invite')}</option>
            <option value="open">{t('host.form.joinMode.open')}</option>
          </select>
        </label>
        <p className={ui.hint}>{t('host.form.firewall')}</p>
        {busy && (
          <p className={ui.status} role="status">
            <span className={`${host.live} ${host.liveOn}`} aria-hidden="true" />
            {t('host.form.starting')}
          </p>
        )}
        <ErrorLine text={invalid ? t(FIELD_ERROR[invalid]) : errorText} />
        <div className={host.footer}>
          <button type="button" className={ui.button} disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={busy}>
            {t('host.form.submit')}
          </button>
        </div>
      </form>
    </HostDialog>
  );
}
