import { useId, useMemo, useState } from 'react';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, Select, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { byNickname } from '../../stores/members.js';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { transferOwnership } from '../chat/actions.js';

/** Owner only (spec §3.3): hand the server to another member, with a second confirmation. */
export function TransferTab() {
  const t = useT();
  const toId = useId();
  const owner = useTextStore((st) => isOwner(st.server));
  const selfId = useTextStore((st) => st.server.selfId);
  const members = useTextStore((st) => st.members.byId);
  const candidates = useMemo(() => Object.values(members).filter((m) => m.userId !== selfId).sort(byNickname), [members, selfId]);
  const [target, setTarget] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = candidates.find((m) => m.userId === target);

  if (!owner) return <p className={s.hint}>{t('serverSettings.transfer.onlyOwner')}</p>;

  const transfer = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await transferOwnership(chosen.userId);
      setArmed(false);
      setTarget('');
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.form}>
      <p className={s.warning}>{t('serverSettings.transfer.body')}</p>
      <div className={s.field}>
        <span id={toId} className={s.label}>
          {t('serverSettings.transfer.to')}
        </span>
        <Select
          labelledBy={toId}
          value={target}
          options={[{ value: '', label: t('serverSettings.transfer.choose') }, ...candidates.map((m) => ({ value: m.userId, label: m.nickname }))]}
          onChange={(userId) => {
            setTarget(userId);
            setArmed(false);
          }}
        />
      </div>
      {error && <ErrorText code={error} />}
      <div className={s.row}>
        {!armed ? (
          <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={!chosen} onClick={() => setArmed(true)}>
            {t('serverSettings.transfer.confirm1')}
          </button>
        ) : (
          <>
            <button type="button" className={p.button} onClick={() => setArmed(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={busy} onClick={() => void transfer()} autoFocus>
              {t('serverSettings.transfer.confirm2', { name: chosen?.nickname ?? '' })}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
