import { useEffect, useState } from 'react';
import { IdCard } from 'lucide-react';
import { PERMISSIONS, has, type Channel } from '@ghostlink/shared';
import { formatChannelLink } from '../../../shared/channelLink.js';
import { NOTIFY_MODES, type ChannelPrefsPatch, type Locale, type SavedServer } from '../../../shared/ipcTypes.js';
import { useT } from '../../i18n/index.js';
import { ConfirmDialog, Menu, MenuItem, MenuRadio, MenuSeparator, MenuSub, type MenuAnchor } from '../../layout/primitives.js';
import { isUnread, readMark } from '../../stores/channels.js';
import { useConnectionStore } from '../../stores/connection.js';
import { myPermissions } from '../../stores/server.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { deleteChannel, markRead } from '../chat/actions.js';
import { useProfileCardStore } from '../profileCard/profileCardStore.js';
import { CreateChannelDialog } from '../server-settings/CreateChannelDialog.js';
import { channelMenuEntries, duplicateName, muteEnd, MUTE_MINUTES, type ChannelMenuEntry } from './channelMenuModel.js';
import { channelPrefsOf, isChannelMuted, isChannelPinned, serverNotifyMode } from './channelPrefs.js';
import { setChannelPrefs } from './useSavedServer.js';

/** The dialogs of the main layout the menu opens: the invite (with the channel) and the settings (on it). */
export type ChannelMenuDialog = 'invite' | 'settings';

export interface ChannelMenuProps {
  channel: Channel;
  anchor: MenuAnchor;
  /** The server's saved entry: the channel's choices and the pins (null until read). */
  saved: SavedServer | null;
  onClose: () => void;
  onOpen: (dialog: ChannelMenuDialog, channelId: string) => void;
  /** The channel is a site I manage (v0.7.0): its two items. */
  site?: { onEdit: () => void; onRemove: () => void };
}

/** When a timed mute ends: the time today, else the date and time. */
function muteEndText(until: number, locale: Locale, now: number): string {
  const end = new Date(until);
  if (end.toDateString() === new Date(now).toDateString()) return end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return end.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * A text channel's menu (spec 2026-10-02-menu-do-canal): mark read, invite to it, pin it, copy its link,
 * mute it, its notifications, the managers' edit/duplicate/create/delete, and its id; each only when it
 * makes sense (channelMenuEntries).
 */
export function ChannelMenu({ channel, anchor, saved, onClose, onOpen, site }: ChannelMenuProps) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const mark = useTextStore((st) => readMark(st.channels, channel.id));
  const serverKeyId = useConnectionStore((st) => (st.welcome !== null && st.welcome.serverId === server.serverId ? st.welcome.server.serverKeyId : null));
  const [dialog, setDialog] = useState<'duplicate' | 'createText' | 'delete' | null>(null);

  // One floating thing at a time: the menu replaces an open profile card.
  useEffect(() => useProfileCardStore.getState().close(), []);

  const now = Date.now();
  const prefs = channelPrefsOf(saved, channel.id);
  const muted = isChannelMuted(prefs, now);
  const bits = myPermissions({ server, members });
  const { entries, disabled } = channelMenuEntries({
    unread: isUnread(channel, mark),
    canInvite: has(bits, PERMISSIONS.CREATE_INVITES),
    canManageChannels: has(bits, PERMISSIONS.MANAGE_CHANNELS),
    pinned: isChannelPinned(saved, channel.id),
    muted,
    manageSite: site !== undefined,
  });

  /** An action that ends the menu. */
  const act = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  /** Changes the channel's choices here; `patch` is read at the click (a mute's end counts from then). */
  const change = (patch: () => ChannelPrefsPatch) => act(() => server.serverId !== null && setChannelPrefs(server.serverId, channel.id, patch()));
  const copy = (text: string) => window.ghostlink.app.copyText(text).catch(() => undefined);

  if (dialog === 'duplicate') {
    const prefill = { name: duplicateName(channel.name, t('channelMenu.copySuffix')), topic: channel.topic, private: channel.private, allowedRoleIds: channel.allowedRoleIds };
    return <CreateChannelDialog type="text" prefill={prefill} onClose={onClose} />;
  }
  if (dialog === 'createText') return <CreateChannelDialog type="text" onClose={onClose} />;
  if (dialog === 'delete') {
    return (
      <ConfirmDialog
        title={t('serverSettings.channels.delete')}
        body={t('serverSettings.channels.deleteConfirm', { name: channel.name })}
        confirmLabel={t('serverSettings.channels.delete')}
        onConfirm={() => deleteChannel(channel.id)}
        onClose={onClose}
      />
    );
  }

  const ownMode = prefs.notify;
  const serverMode = serverNotifyMode(saved);

  const item = (entry: ChannelMenuEntry, key: number) => {
    switch (entry) {
      case 'separator':
        return <MenuSeparator key={key} />;
      case 'markRead':
        return (
          <MenuItem key={entry} disabled={disabled.has(entry)} onSelect={act(() => markRead(channel.id, channel.lastMessageId).catch(() => undefined))}>
            {t('channelMenu.markRead')}
          </MenuItem>
        );
      case 'invite':
        return (
          <MenuItem key={entry} onSelect={act(() => onOpen('invite', channel.id))}>
            {t('channelMenu.invite')}
          </MenuItem>
        );
      case 'pin':
        return (
          <MenuItem key={entry} onSelect={change(() => ({ pinned: true }))}>
            {t('channelMenu.pin')}
          </MenuItem>
        );
      case 'unpin':
        return (
          <MenuItem key={entry} onSelect={change(() => ({ pinned: false }))}>
            {t('channelMenu.unpin')}
          </MenuItem>
        );
      case 'copyLink':
        return (
          <MenuItem key={entry} disabled={serverKeyId === null} onSelect={act(() => serverKeyId !== null && copy(formatChannelLink(serverKeyId, channel.id)))}>
            {t('channelMenu.copyLink')}
          </MenuItem>
        );
      case 'mute':
        return (
          <MenuSub key={entry} label={t('channelMenu.mute')} menuLabel={t('channelMenu.muteFor', { name: channel.name })}>
            {MUTE_MINUTES.map((minutes) => (
              <MenuItem key={minutes ?? 'forever'} onSelect={change(() => ({ mutedUntil: muteEnd(minutes, Date.now()) }))}>
                {t(minutes === null ? 'channelMenu.mute.forever' : `channelMenu.mute.${minutes}`)}
              </MenuItem>
            ))}
          </MenuSub>
        );
      case 'unmute':
        return (
          <MenuItem
            key={entry}
            hint={typeof prefs.mutedUntil === 'number' ? t('channelMenu.mutedUntil', { time: muteEndText(prefs.mutedUntil, locale, now) }) : undefined}
            onSelect={change(() => ({ mutedUntil: false }))}
          >
            {t('channelMenu.unmute')}
          </MenuItem>
        );
      case 'notify':
        return (
          <MenuSub
            key={entry}
            label={t('channelMenu.notify')}
            hint={ownMode === undefined ? t('channelMenu.notify.default') : t(`notifications.mode.${ownMode}`)}
            menuLabel={t('channelMenu.notify')}
            width={240}
          >
            <MenuRadio checked={ownMode === undefined} onSelect={change(() => ({ notify: null }))} hint={t(`notifications.mode.${serverMode}`)}>
              {t('channelMenu.notify.default')}
            </MenuRadio>
            {NOTIFY_MODES.map((mode) => (
              <MenuRadio key={mode} checked={ownMode === mode} onSelect={change(() => ({ notify: mode }))}>
                {t(`notifications.mode.${mode}`)}
              </MenuRadio>
            ))}
          </MenuSub>
        );
      case 'editSite':
        return (
          <MenuItem key={entry} onSelect={act(() => site?.onEdit())}>
            {t('sites.edit')}
          </MenuItem>
        );
      case 'removeSite':
        return (
          <MenuItem key={entry} danger onSelect={act(() => site?.onRemove())}>
            {t('sites.remove')}
          </MenuItem>
        );
      case 'edit':
        return (
          <MenuItem key={entry} onSelect={act(() => onOpen('settings', channel.id))}>
            {t('channelMenu.edit')}
          </MenuItem>
        );
      case 'duplicate':
        return (
          <MenuItem key={entry} onSelect={() => setDialog('duplicate')}>
            {t('channelMenu.duplicate')}
          </MenuItem>
        );
      case 'createText':
        return (
          <MenuItem key={entry} onSelect={() => setDialog('createText')}>
            {t('channelMenu.createText')}
          </MenuItem>
        );
      case 'delete':
        return (
          <MenuItem key={entry} danger onSelect={() => setDialog('delete')}>
            {t('channelMenu.delete')}
          </MenuItem>
        );
      case 'copyId':
        return (
          <MenuItem key={entry} icon={<IdCard size={16} aria-hidden="true" />} onSelect={act(() => copy(channel.id))}>
            {t('channelMenu.copyId')}
          </MenuItem>
        );
    }
  };

  return (
    <Menu anchor={anchor} label={t('channelMenu.label', { name: channel.name })} onClose={onClose} width={240}>
      {entries.map(item)}
    </Menu>
  );
}
