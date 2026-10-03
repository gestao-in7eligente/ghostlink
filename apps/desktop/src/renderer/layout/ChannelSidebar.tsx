import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Lock, LogOut, Plus, Settings, Trash2, UserPlus, Volume2 } from 'lucide-react';
import { PERMISSIONS, has, type Channel, type ChannelType } from '@ghostlink/shared';
import { GhostMark } from '../components/GhostMark.js';
import { BotsSection } from '../features/bots/BotsSection.js';
import { ChannelMenu } from '../features/channelMenu/ChannelMenu.js';
import { nextMuteEnd, pinnedFirst } from '../features/channelMenu/channelPrefs.js';
import { useSavedServer } from '../features/channelMenu/useSavedServer.js';
import { canOpenServerSettings } from '../features/server-settings/access.js';
import { CreateChannelDialog } from '../features/server-settings/CreateChannelDialog.js';
import { EnterpriseBadge } from '../features/enterprise/EnterpriseBadge.js';
import { useOpenServerExit } from '../features/serverDelete/DeletionBanner.js';
import { SitesSection } from '../features/sites/SitesSection.js';
import { withoutSites } from '../features/sites/siteModel.js';
import { useT } from '../i18n/index.js';
import { sortedChannels } from '../stores/channels.js';
import { useEnterpriseStore } from '../stores/enterprise.js';
import { myPermissions } from '../stores/server.js';
import { dispatchText, useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import { Menu, MenuItem, MenuSeparator, ServerIcon, type MenuAnchor } from './primitives.js';
import { useLayoutSlots } from './slots.js';
import { TextChannelRow, type TextRowContext } from './TextChannelRow.js';

export type SidebarDialog = 'invite' | 'settings' | 'leave' | 'delete';

/**
 * Server header with its menu, then BOTS, SITES (Enterprise, v0.7.0), the text and the voice channels (spec §11.1 item 4). A text channel's
 * right click (or menu key) opens its menu (spec 2026-10-02-menu-do-canal); `channelId` names the channel
 * an invite or the settings opened from it are about.
 */
export function ChannelSidebar({ onOpen }: { onOpen: (dialog: SidebarDialog, channelId?: string) => void }) {
  const t = useT();
  const name = useTextStore((s) => s.server.name);
  const icon = useTextStore((s) => s.server.icon);
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const byId = useTextStore((s) => s.channels.byId);
  const sites = useEnterpriseStore((s) => s.sites);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [creating, setCreating] = useState<ChannelType | null>(null);
  const [channelMenu, setChannelMenu] = useState<{ channelId: string; anchor: MenuAnchor } | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  // My choices for this server's channels (pins, mutes), kept on this computer.
  const saved = useSavedServer(server.serverId);
  const [tick, setTick] = useState(0);

  // A timed mute ends by itself: the channel shows normally again at that moment.
  useEffect(() => {
    const end = nextMuteEnd(saved, Date.now());
    if (end === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(end - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [saved, tick]);

  const bits = useMemo(() => myPermissions({ server, members }), [server, members]);
  const canInvite = has(bits, PERMISSIONS.CREATE_INVITES);
  const canSettings = canOpenServerSettings(bits, server.ownerId === server.selfId);
  const canManageChannels = has(bits, PERMISSIONS.MANAGE_CHANNELS);
  // Members leave, the owner deletes (leave/delete spec §2, §3).
  const exit = useOpenServerExit();
  const text = useMemo(() => pinnedFirst(withoutSites(sortedChannels(byId, 'text'), sites), saved?.pinned), [byId, saved, sites]);
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
        {icon ? <ServerIcon name={name} hash={icon} size={22} /> : <GhostMark size={22} />}
        <span className={l.serverName}>{name}</span>
        <EnterpriseBadge />
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
          {(canInvite || canSettings) && exit !== null && <MenuSeparator />}
          {exit === 'leave' && (
            <MenuItem danger onSelect={() => pick('leave')} icon={<LogOut size={16} aria-hidden="true" />}>
              {t('layout.leave')}
            </MenuItem>
          )}
          {exit === 'delete' && (
            <MenuItem danger onSelect={() => pick('delete')} icon={<Trash2 size={16} aria-hidden="true" />}>
              {t('serverExit.delete')}
            </MenuItem>
          )}
        </Menu>
      )}

      <div className={l.channelScroll}>
        <BotsSection />
        <SitesSection saved={saved} onOpen={onOpen} />
        <ChannelSection
          title={t('layout.textChannels')}
          type="text"
          channels={text}
          canCreate={canManageChannels}
          onCreate={() => setCreating('text')}
          textRow={{ saved, now: Date.now(), openMenu: (channelId, anchor) => setChannelMenu({ channelId, anchor }) }}
        />
        {text.length === 0 && <p className={l.emptyHint}>{t('layout.noChannel')}</p>}
        <ChannelSection title={t('layout.voiceChannels')} type="voice" channels={voice} canCreate={canManageChannels} onCreate={() => setCreating('voice')} />
      </div>
      {creating && <CreateChannelDialog type={creating} onClose={() => setCreating(null)} />}
      {channelMenu && Object.hasOwn(byId, channelMenu.channelId) && (
        <ChannelMenu
          channel={byId[channelMenu.channelId]!}
          anchor={channelMenu.anchor}
          saved={saved}
          onClose={() => setChannelMenu(null)}
          onOpen={onOpen}
        />
      )}
    </aside>
  );
}

function ChannelSection({
  title,
  type,
  channels,
  canCreate,
  onCreate,
  textRow,
}: {
  title: string;
  type: ChannelType;
  channels: Channel[];
  canCreate: boolean;
  onCreate: () => void;
  textRow?: TextRowContext;
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
        {channels.map((c) => (type === 'text' && textRow ? <TextChannelRow key={c.id} channel={c} context={textRow} /> : <VoiceChannelRow key={c.id} channel={c} />))}
      </ul>
    </section>
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
