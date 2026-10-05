import type { ReactNode } from 'react';
import { Hash, Lock } from 'lucide-react';
import type { Channel } from '@ghostlink/shared';
import type { SavedServer } from '../../shared/ipcTypes.js';
import { channelPrefsOf, isChannelMuted } from '../features/channelMenu/channelPrefs.js';
import { userMenuTriggers } from '../features/userMenu/triggers.js';
import { useT } from '../i18n/index.js';
import { centerView, isUnread, readMark } from '../stores/channels.js';
import { dispatchText, useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import type { MenuAnchor } from './primitives.js';

/** What a text channel row needs from the sidebar: my choices for it, the time, and its menu. */
export interface TextRowContext {
  saved: SavedServer | null;
  now: number;
  openMenu: (channelId: string, anchor: MenuAnchor) => void;
}

/**
 * A text channel in the sidebar: unread, mentions, muted, its menu on right click. `icon` and `label`
 * replace the # and the channel's name when a caller shows the channel another way.
 */
export function TextChannelRow({ channel, context, icon, label }: { channel: Channel; context: TextRowContext; icon?: ReactNode; label?: string }) {
  const t = useT();
  const active = useTextStore((s) => s.channels.activeId === channel.id && centerView(s.channels) === 'chat');
  const mark = useTextStore((s) => readMark(s.channels, channel.id));
  // Muted (its menu): dimmed and never bold; its mentions still count.
  const muted = isChannelMuted(channelPrefsOf(context.saved, channel.id), context.now);
  const unread = !active && !muted && isUnread(channel, mark);
  const mentions = mark.mentionCount;
  const shown = label ?? channel.name;
  const className = [l.channel, muted ? l.channelMuted : '', active ? l.channelActive : '', unread ? l.channelUnread : ''].filter(Boolean).join(' ');
  const triggers = userMenuTriggers((anchor) => context.openMenu(channel.id, anchor));
  const ariaLabel = [
    shown,
    channel.private ? t('layout.privateChannel') : null,
    muted ? t('channelMenu.mutedLabel') : null,
    unread ? t('layout.unread') : null,
    mentions > 0 ? t('layout.mentions', { count: mentions }) : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <li className={l.channelItem}>
      <button
        type="button"
        className={className}
        aria-current={active ? 'page' : undefined}
        aria-label={ariaLabel}
        onClick={() => dispatchText({ type: 'select', channelId: channel.id })}
        {...triggers}
        data-channel={channel.id}
      >
        {icon ?? <Hash className={l.channelIcon} size={18} aria-hidden="true" />}
        <span className={l.channelName}>{shown}</span>
        {channel.private && <Lock className={l.lock} size={13} aria-hidden="true" />}
        {mentions > 0 && (
          <span className={l.mentionBadge} aria-hidden="true">
            {mentions > 99 ? '99+' : mentions}
          </span>
        )}
      </button>
    </li>
  );
}
