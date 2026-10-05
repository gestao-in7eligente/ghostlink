import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Hash, Lock, Pencil, Trash2, Volume2 } from 'lucide-react';
import type { Channel, ChannelType } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ConfirmDialog, ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { sortedChannels } from '../../stores/channels.js';
import { useTextStore } from '../../stores/text.js';
import { deleteChannel, reorderChannels } from '../chat/actions.js';
import { moveChannel } from './access.js';
import { CreateChannelDialog } from './CreateChannelDialog.js';

/**
 * Create, edit, reorder and delete channels (MANAGE_CHANNELS). `editId`: opens with that channel's editor
 * (the channel menu's "Editar canal"), and `onEditClosed` says when any editor closed.
 */
export function ChannelsTab({ editId, onEditClosed }: { editId?: string; onEditClosed?: () => void }) {
  const t = useT();
  const byId = useTextStore((st) => st.channels.byId);
  const all = useMemo(() => Object.values(byId), [byId]);
  const [editing, setEditing] = useState<Channel | null>(() => (editId !== undefined && Object.hasOwn(byId, editId) ? byId[editId]! : null));
  const [creating, setCreating] = useState<ChannelType | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = async (id: string, delta: -1 | 1) => {
    const ids = moveChannel(all, id, delta);
    if (!ids) return;
    setError(null);
    try {
      await reorderChannels(ids);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  const section = (type: ChannelType) => {
    const list = sortedChannels(byId, type);
    const Icon = type === 'text' ? Hash : Volume2;
    return (
      <div className={s.field}>
        <div className={s.row}>
          <span className={s.label}>{type === 'text' ? t('layout.textChannels') : t('layout.voiceChannels')}</span>
          <span className={s.spacer} />
          <button type="button" className={`${p.button} ${s.small}`} onClick={() => setCreating(type)}>
            {t('layout.createChannel')}
          </button>
        </div>
        {list.length === 0 && <p className={s.hint}>{t('serverSettings.channels.none')}</p>}
        <ul className={s.list}>
          {list.map((c, i) => (
            <li key={c.id} className={s.item}>
              <Icon size={18} className={s.grip} aria-hidden="true" />
              <span className={s.itemMain}>
                <span className={s.itemTitle}>
                  {c.name}
                  {c.private && <Lock size={13} aria-label={t('layout.privateChannel')} />}
                </span>
                {c.topic && <span className={s.itemMeta}>{c.topic}</span>}
              </span>
              <span className={s.itemActions}>
                <button type="button" className={p.iconButton} disabled={i === 0} onClick={() => void move(c.id, -1)} aria-label={`${t('serverSettings.channels.moveUp')}: ${c.name}`} title={t('serverSettings.channels.moveUp')}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={p.iconButton}
                  disabled={i === list.length - 1}
                  onClick={() => void move(c.id, 1)}
                  aria-label={`${t('serverSettings.channels.moveDown')}: ${c.name}`}
                  title={t('serverSettings.channels.moveDown')}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
                <button type="button" className={p.iconButton} onClick={() => setEditing(c)} aria-label={`${t('serverSettings.channels.edit')}: ${c.name}`} title={t('serverSettings.channels.edit')}>
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button type="button" className={p.iconButton} onClick={() => setDeleting(c)} aria-label={`${t('serverSettings.channels.delete')}: ${c.name}`} title={t('serverSettings.channels.delete')}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className={s.form}>
      {section('text')}
      {section('voice')}
      {error && <ErrorText code={error} />}
      {(editing || creating) && (
        <CreateChannelDialog
          channel={editing ?? undefined}
          type={creating ?? undefined}
          onClose={() => {
            setEditing(null);
            setCreating(null);
            onEditClosed?.();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('serverSettings.channels.delete')}
          body={t('serverSettings.channels.deleteConfirm', { name: deleting.name })}
          confirmLabel={t('serverSettings.channels.delete')}
          onConfirm={() => deleteChannel(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
