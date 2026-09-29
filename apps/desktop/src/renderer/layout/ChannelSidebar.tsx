import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Hash, Lock, LogOut, Plus, Settings, UserPlus, Volume2 } from 'lucide-react';
import { PERMISSIONS, has, type Channel, type ChannelType } from '@ghostlink/shared';
import { GhostMark } from '../components/GhostMark.js';
import { canOpenServerSettings } from '../features/server-settings/access.js';
import { CreateChannelDialog } from '../features/server-settings/CreateChannelDialog.js';
import { useT } from '../i18n/index.js';
import { isUnread, readMark, sortedChannels } from '../stores/channels.js';
import { myPermissions } from '../stores/server.js';
import { dispatchText, useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import { Menu, MenuItem, MenuSeparator } from './primitives.js';
import { useLayoutSlots } from './slots.js';

export type SidebarDialog = 'invite' | 'settings' | 'leave';

/** Server header with its menu, then the text and voice channels (spec §11.1 item 4). */
export function ChannelSidebar({ onOpen }: { onOpen: (dialog: SidebarDialog) => void }) {
  const t = useT();
  const name = useTextStore((s) => s.server.name);
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const byId = useTextStore((s) => s.channels.byId);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [creating, setCreating] = useState<ChannelType | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);

  const bits = useMemo(() => myPermissions({ server, members }), [server, members]);
  const canInvite = has(bits, PERMISSIONS.CREATE_INVITES);
  const canSettings = canOpenServerSettings(bits, server.ownerId === server.selfId);
  const canManageChannels = has(bits, PERMISSIONS.MANAGE_CHANNELS);
  const text = useMemo(() => sortedChannels(byId, 'text'), [byId]);
  const voice = useMemo(() => sortedChannels(byId, 'voice'), [byId]);

  const pick = (dialog: SidebarDialog) => {
    setMenu(null);
    onOpen(dialog);
  };

  return (
    <aside className={l.sidebar} aria-label={t('layout.channels')}>
      <button
        ref={headerRef}
        type="button"
        className={l.serverHeader}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => setMenu(menu ? null : (headerRef.current?.getBoundingClientRect() ?? null))}
      >
        <GhostMark size={22} />
        <span className={l.serverName}>{name}</span>
        <ChevronDown className={l.chevron} size={16} aria-hidden="true" />
        <span className={l.visuallyHidden}>{t('layout.serverMenu')}</span>
      </button>
      {menu && (
        <Menu anchor={menu} label={t('layout.serverMenu')} onClose={() => setMenu(null)} width={248}>
          {canInvite && (
            <MenuItem onSelect={() => pick('invite')} icon={<UserPlus size={16} aria-hidden="true" />}>
              {t('layout.invite')}
            </MenuItem>
          )}
          {canSettings && (
            <MenuItem onSelect={() => pick('settings')} icon={<Settings size={16} aria-hidden="true" />}>
              {t('layout.serverSettings')}
            </MenuItem>
          )}
          {(canInvite || canSettings) && <MenuSeparator />}
          <MenuItem danger onSelect={() => pick('leave')} icon={<LogOut size={16} aria-hidden="true" />}>
            {t('layout.leave')}
          </MenuItem>
        </Menu>
      )}

      <div className={l.channelScroll}>
        <ChannelSection title={t('layout.textChannels')} type="text" channels={text} canCreate={canManageChannels} onCreate={() => setCreating('text')} />
        {text.length === 0 && <p className={l.emptyHint}>{t('layout.noChannel')}</p>}
        <ChannelSection title={t('layout.voiceChannels')} type="voice" channels={voice} canCreate={canManageChannels} onCreate={() => setCreating('voice')} />
      </div>
      {creating && <CreateChannelDialog type={creating} onClose={() => setCreating(null)} />}
    </aside>
  );
}

function ChannelSection({
  title,
  type,
  channels,
  canCreate,
  onCreate,
}: {
  title: string;
  type: ChannelType;
  channels: Channel[];
  canCreate: boolean;
  onCreate: () => void;
}) {
  const t = useT();
  const headingId = `section-${type}`;
  return (
    <section className={l.section} aria-labelledby={headingId}>
      <div className={l.sectionHeader}>
        <h2 id={headingId} className={l.sectionTitle}>
          {title}
        </h2>
        {canCreate && (
          <button type="button" className={l.sectionAdd} onClick={onCreate} aria-label={t('layout.createChannel')} title={t('layout.createChannel')}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className={l.channelList}>
        {channels.map((c) => (type === 'text' ? <TextChannelRow key={c.id} channel={c} /> : <VoiceChannelRow key={c.id} channel={c} />))}
      </ul>
    </section>
  );
}

function TextChannelRow({ channel }: { channel: Channel }) {
  const t = useT();
  const active = useTextStore((s) => s.channels.activeId === channel.id && s.channels.stageId === null);
  const mark = useTextStore((s) => readMark(s.channels, channel.id));
  const unread = !active && isUnread(channel, mark);
  const mentions = mark.mentionCount;
  const className = [l.channel, active ? l.channelActive : '', unread ? l.channelUnread : ''].filter(Boolean).join(' ');
  const label = [
    channel.name,
    channel.private ? t('layout.privateChannel') : null,
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
        aria-label={label}
        onClick={() => dispatchText({ type: 'select', channelId: channel.id })}
        data-channel={channel.id}
      >
        <Hash className={l.channelIcon} size={18} aria-hidden="true" />
        <span className={l.channelName}>{channel.name}</span>
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

function VoiceChannelRow({ channel }: { channel: Channel }) {
  const t = useT();
  const staged = useTextStore((s) => s.channels.stageId === channel.id);
  const Participants = useLayoutSlots((s) => s.VoiceChannelParticipants);
  const onJoinVoice = useLayoutSlots((s) => s.onJoinVoice);
  const hasStage = useLayoutSlots((s) => s.VoiceStage !== null);
  const open = () => {
    if (hasStage) dispatchText({ type: 'stage', channelId: channel.id });
    onJoinVoice?.(channel.id);
  };
  return (
    <li className={l.channelItem}>
      <button
        type="button"
        className={staged ? `${l.channel} ${l.channelActive}` : l.channel}
        aria-current={staged ? 'page' : undefined}
        aria-label={t('layout.joinVoice', { channel: channel.name })}
        title={t('layout.joinVoice', { channel: channel.name })}
        onClick={open}
        data-voice-channel={channel.id}
      >
        <Volume2 className={l.channelIcon} size={18} aria-hidden="true" />
        <span className={l.channelName}>{channel.name}</span>
        {channel.private && <Lock className={l.lock} size={13} aria-hidden="true" />}
      </button>
      {Participants && (
        <div className={l.voiceSlot}>
          <Participants channelId={channel.id} />
        </div>
      )}
    </li>
  );
}
