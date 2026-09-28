import { useMemo, useState, type FormEvent } from 'react';
import { CHAT_LIMITS, roleColorHex, type Channel, type ChannelType } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, Modal, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { rolesByPosition } from '../../stores/server.js';
import { dispatchText, useTextStore } from '../../stores/text.js';
import { createChannel, updateChannel } from '../chat/actions.js';

/**
 * Creates a channel of `type`, or edits `channel`: name, topic, voice limit, and
 * privacy with the roles allowed to see it (spec §6: admins and the owner always do).
 */
export function CreateChannelDialog({ type, channel, onClose }: { type?: ChannelType; channel?: Channel; onClose: () => void }) {
  const t = useT();
  const kind = channel?.type ?? type ?? 'text';
  const roles = useTextStore((st) => st.server.roles);
  const roleList = useMemo(() => rolesByPosition(roles).filter((r) => !r.isDefault), [roles]);
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [isPrivate, setPrivate] = useState(channel?.private ?? false);
  const [allowed, setAllowed] = useState<string[]>(channel?.allowedRoleIds ?? []);
  const [userLimit, setUserLimit] = useState(channel?.userLimit ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const common = {
      topic: kind === 'text' ? topic : undefined,
      private: isPrivate,
      allowedRoleIds: isPrivate ? allowed.filter((id) => Object.hasOwn(roles, id)) : [],
      userLimit: kind === 'voice' ? userLimit : undefined,
    };
    try {
      if (channel) {
        await updateChannel(channel.id, { name, ...common });
      } else {
        const created = await createChannel({ name, type: kind, ...common });
        if (created.type === 'text') dispatchText({ type: 'select', channelId: created.id });
      }
      onClose();
    } catch (err) {
      setError(errorCodeOf(err));
      setBusy(false);
    }
  };

  const title = channel ? t('serverSettings.channels.editTitle', { name: channel.name }) : t(kind === 'text' ? 'serverSettings.channels.createText' : 'serverSettings.channels.createVoice');

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="channel-form" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || name.trim() === ''}>
            {channel ? t('serverSettings.save') : t('serverSettings.channels.create')}
          </button>
        </>
      }
    >
      <form id="channel-form" className={s.form} onSubmit={(e) => void submit(e)}>
        <label className={s.field}>
          <span className={s.label}>{t('serverSettings.channels.name')}</span>
          <input className={s.input} value={name} maxLength={CHAT_LIMITS.channelNameMax} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
        </label>
        {kind === 'text' ? (
          <label className={s.field}>
            <span className={s.label}>{t('serverSettings.channels.topic')}</span>
            <input className={s.input} value={topic} maxLength={CHAT_LIMITS.topicMax} onChange={(e) => setTopic(e.target.value)} autoComplete="off" />
          </label>
        ) : (
          <label className={s.field}>
            <span className={s.label}>{t('serverSettings.channels.userLimit')}</span>
            <input
              className={s.input}
              type="number"
              min={0}
              max={CHAT_LIMITS.userLimitMax}
              value={userLimit}
              onChange={(e) => setUserLimit(Math.max(0, Math.min(CHAT_LIMITS.userLimitMax, Math.trunc(Number(e.target.value) || 0))))}
            />
          </label>
        )}
        <label className={s.perm}>
          <span className={s.permText}>
            <span className={s.permName}>{t('serverSettings.channels.private')}</span>
            <span className={s.hint}>{t('serverSettings.channels.privateHint')}</span>
          </span>
          <input type="checkbox" role="switch" className={s.switch} checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
        </label>
        {isPrivate && (
          <fieldset className={s.field} style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className={s.label}>{t('serverSettings.channels.allowedRoles')}</legend>
            {roleList.length === 0 && <p className={s.hint}>{t('serverSettings.channels.noRoles')}</p>}
            {roleList.map((r) => {
              const color = roleColorHex(r.color);
              return (
                <label key={r.id} className={s.check}>
                  <input
                    type="checkbox"
                    checked={allowed.includes(r.id)}
                    onChange={(e) => setAllowed((list) => (e.target.checked ? [...list, r.id] : list.filter((id) => id !== r.id)))}
                  />
                  <span className={s.roleSwatch} style={color ? { background: color } : undefined} aria-hidden="true" />
                  <span>{r.name}</span>
                </label>
              );
            })}
          </fieldset>
        )}
        {error && <ErrorText code={error} />}
      </form>
    </Modal>
  );
}
