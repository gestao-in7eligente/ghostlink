import { useEffect, useState } from 'react';
import type { BanEntry } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useSettingsStore } from '../../stores/settings.js';
import { formatStamp } from '../chat/grouping.js';
import { listBans, unbanMember } from '../chat/actions.js';

/** Banned identities with their reason; unban lets them join again through the join mode (BAN_MEMBERS). */
export function BansTab() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [bans, setBans] = useState<BanEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listBans().then(
      (list) => alive && setBans(list),
      (e: unknown) => {
        if (!alive) return;
        setError(errorCodeOf(e));
        setBans([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const unban = async (userId: string) => {
    setError(null);
    try {
      await unbanMember(userId);
      setBans((list) => list?.filter((b) => b.userId !== userId) ?? null);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  return (
    <div className={s.form}>
      {error && <ErrorText code={error} />}
      {bans?.length === 0 && <p className={s.hint}>{t('serverSettings.bans.none')}</p>}
      <ul className={s.list}>
        {bans?.map((b) => (
          <li key={b.userId} className={s.item}>
            <span className={s.itemMain}>
              <span className={s.itemTitle}>{b.nickname || t('chat.formerMember')}</span>
              <span className={s.itemMeta}>
                {[formatStamp(b.createdAt, locale), b.reason ? t('serverSettings.bans.reason', { reason: b.reason }) : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button type="button" className={`${p.button} ${s.small}`} onClick={() => void unban(b.userId)}>
              {t('serverSettings.bans.unban')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
