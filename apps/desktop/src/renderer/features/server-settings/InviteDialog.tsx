import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { InviteLinks } from '@ghostlink/shared';
import { errorCodeOf, useT, type Translate } from '../../i18n/index.js';
import { ErrorText, Modal, Select, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useTextStore } from '../../stores/text.js';
import { inviteLinksWithChannel } from '../channelMenu/channelMenuModel.js';
import { createInvite } from '../chat/actions.js';

export const MAX_USES_CHOICES = [0, 1, 5, 10, 25, 100] as const;
export const EXPIRY_CHOICES = [1, 24, 24 * 7, 0] as const;

export function expiryLabel(t: Translate, hours: number): string {
  if (hours === 0) return t('serverSettings.invites.never');
  return hours < 48 ? t('serverSettings.invites.hours', { count: hours }) : t('serverSettings.invites.days', { count: hours / 24 });
}

/** Max uses and validity pickers, shared by the quick invite and the Invites tab. */
export function InviteOptions({ maxUses, setMaxUses, hours, setHours }: { maxUses: number; setMaxUses: (n: number) => void; hours: number; setHours: (n: number) => void }) {
  const t = useT();
  const ids = { expires: useId(), maxUses: useId() };
  return (
    <div className={s.row}>
      <div className={s.field} style={{ flex: 1 }}>
        <span id={ids.expires} className={s.label}>
          {t('serverSettings.invites.expires')}
        </span>
        <Select<number> labelledBy={ids.expires} value={hours} options={EXPIRY_CHOICES.map((h) => ({ value: h, label: expiryLabel(t, h) }))} onChange={setHours} />
      </div>
      <div className={s.field} style={{ flex: 1 }}>
        <span id={ids.maxUses} className={s.label}>
          {t('serverSettings.invites.maxUses')}
        </span>
        <Select<number>
          labelledBy={ids.maxUses}
          value={maxUses}
          options={MAX_USES_CHOICES.map((n) => ({ value: n, label: n === 0 ? t('serverSettings.invites.unlimited') : String(n) }))}
          onChange={setMaxUses}
        />
      </div>
    </div>
  );
}

export function inviteRequest(maxUses: number, hours: number): { maxUses?: number; expiresInHours?: number } {
  return { ...(maxUses > 0 ? { maxUses } : {}), ...(hours > 0 ? { expiresInHours: hours } : {}) };
}

/** A read-only value with a copy button (Electron clipboard through the main process). */
export function CopyField({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await window.ghostlink.app.copyText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={s.field}>
      <span className={s.label}>{label}</span>
      <div className={s.row}>
        <code className={s.code} style={{ flex: 1 }}>
          {value}
        </code>
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => void copy()}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copied ? t('chat.copied') : t('serverSettings.invites.copy')}
        </button>
      </div>
    </div>
  );
}

/**
 * "Convidar pessoas" (server menu): a fresh invite link to share (spec §3.5). `channelId`: the channel
 * menu's "Convite para o canal", whose links also carry the channel whoever joins lands in.
 */
export function InviteDialog({ onClose, channelId }: { onClose: () => void; channelId?: string }) {
  const t = useT();
  const name = useTextStore((st) => st.server.name);
  const channel = useTextStore((st) => (channelId !== undefined && Object.hasOwn(st.channels.byId, channelId) ? st.channels.byId[channelId]! : null));
  const [maxUses, setMaxUses] = useState(0);
  const [hours, setHours] = useState(24 * 7);
  const [invite, setInvite] = useState<InviteLinks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const links = await createInvite(inviteRequest(maxUses, hours));
      setInvite(channel ? inviteLinksWithChannel(links, channel.id) : links);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('invite.title', { name })} onClose={onClose} size="medium">
      <div className={s.form}>
        {channel && <p className={s.hint}>{t('channelMenu.inviteHint', { name: channel.name })}</p>}
        <InviteOptions maxUses={maxUses} setMaxUses={setMaxUses} hours={hours} setHours={setHours} />
        <div className={s.row}>
          <button type="button" className={`${p.button} ${invite ? '' : p.buttonPrimary}`} disabled={busy} onClick={() => void generate()}>
            {invite ? t('invite.generateAnother') : t('invite.generate')}
          </button>
        </div>
        {error && <ErrorText code={error} />}
        {invite && (
          <>
            <CopyField label={t('invite.link')} value={invite.webLink} />
            <p className={s.hint}>{t('serverSettings.invites.linkHint')}</p>
            <CopyField label={t('invite.pasteCode')} value={invite.pasteCode} />
          </>
        )}
      </div>
    </Modal>
  );
}
