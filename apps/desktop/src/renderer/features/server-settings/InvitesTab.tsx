import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';
import type { InviteEntry, InviteLinks } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { createInvite, listInvites, revokeInvite } from '../chat/actions.js';
import { memberName } from '../chat/notify.js';
import { formatStamp } from '../chat/grouping.js';
import { CopyField, InviteOptions, inviteRequest } from './InviteDialog.js';

/** Create (max uses, validity), list, copy and revoke invites (spec §5.2). */
export function InvitesTab() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const members = useTextStore((st) => st.members);
  const [invites, setInvites] = useState<InviteEntry[] | null>(null);
  const [maxUses, setMaxUses] = useState(0);
  const [hours, setHours] = useState(24 * 7);
  const [created, setCreated] = useState<InviteLinks | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInvites(await listInvites());
    } catch (e) {
      setError(errorCodeOf(e));
      setInvites([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createInvite(inviteRequest(maxUses, hours)));
      await refresh();
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setError(null);
    try {
      await revokeInvite(code);
      setInvites((list) => list?.filter((i) => i.code !== code) ?? null);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  const copy = async (invite: InviteEntry) => {
    await window.ghostlink.app.copyText(invite.webLink);
    setCopied(invite.code);
    setTimeout(() => setCopied((c) => (c === invite.code ? null : c)), 1500);
  };

  return (
    <div className={s.form}>
      <InviteOptions maxUses={maxUses} setMaxUses={setMaxUses} hours={hours} setHours={setHours} />
      <div className={s.row}>
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled={busy} onClick={() => void create()}>
          {t('serverSettings.invites.create')}
        </button>
      </div>
      {created && <CopyField label={t('invite.link')} value={created.webLink} />}
      <p className={s.hint}>{t('serverSettings.invites.linkHint')}</p>
      {error && <ErrorText code={error} />}
      {invites?.length === 0 && <p className={s.hint}>{t('serverSettings.invites.none')}</p>}
      <ul className={s.list}>
        {invites?.map((invite) => (
          <li key={invite.code} className={s.item}>
            <span className={s.itemMain}>
              <span className={s.itemTitle}>{invite.code}</span>
              <span className={s.itemMeta}>
                {[
                  invite.createdBy ? memberName({ members }, invite.createdBy, t('chat.formerMember')) : null,
                  invite.maxUses === null
                    ? t('serverSettings.invites.usesUnlimited', { uses: invite.uses })
                    : t('serverSettings.invites.uses', { uses: invite.uses, max: invite.maxUses }),
                  invite.expiresAt === null ? t('serverSettings.invites.never') : t('serverSettings.invites.expiresAt', { date: formatStamp(invite.expiresAt, locale) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className={s.itemActions}>
              <button type="button" className={p.iconButton} onClick={() => void copy(invite)} aria-label={`${t('serverSettings.invites.copy')}: ${invite.code}`} title={t('serverSettings.invites.copy')}>
                {copied === invite.code ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              </button>
              <button type="button" className={p.iconButton} onClick={() => void revoke(invite.code)} aria-label={`${t('serverSettings.invites.revoke')}: ${invite.code}`} title={t('serverSettings.invites.revoke')}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
