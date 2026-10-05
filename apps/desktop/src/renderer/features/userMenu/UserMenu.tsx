import { useEffect, useMemo, useState } from 'react';
import { AtSign, Gavel, IdCard, Pencil, PhoneOff, UserMinus, UserRound } from 'lucide-react';
import { FEATURE_VOICE_SERVER_DEAFEN, PERMISSIONS, has, roleColorHex, type Member } from '@ghostlink/shared';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { ConfirmDialog, Menu, MenuCheckbox, MenuItem, MenuSeparator, MenuSub, primitives as p, type MenuAnchor } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useUserSettingsOpener } from '../../layout/userSettingsOpener.js';
import { useConnectionStore } from '../../stores/connection.js';
import { canActOnMember, manageableRoles, myPermissions } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { banMember, kickMember, setMemberRoles } from '../chat/actions.js';
import { useComposerStore } from '../chat/composerStore.js';
import { userCandidate } from '../chat/mentions.js';
import type { CardSide } from '../profileCard/profileCardModel.js';
import { copyUserId, useProfileCardStore } from '../profileCard/profileCardStore.js';
import { moderateVoice, setLocalMute, toggleDeafen, toggleMute, useVoiceDirectory } from '../voice/runtime.js';
import { isLocallyMuted, useVoiceSettings } from '../voice/settings.js';
import { participantIn, useVoiceStore, viewVoice } from '../voice/state.js';
import { UserVolume } from '../voice/UserVolume.js';
import type { UserMenuRequest } from './triggers.js';
import { userMenuEntries, type UserMenuEntry } from './userMenuModel.js';

export interface UserMenuProps {
  member: Member;
  anchor: MenuAnchor;
  onClose: () => void;
  /** Where "Perfil" opens the card: beside `opener`, on `side`. Absent where no card can show (the server settings). */
  profile?: { opener: HTMLElement; side: CardSide };
}

/**
 * A person's menu (spec 2026-10-02-menu-do-usuario), the same on a message's author, a member
 * row and a call participant: profile, mention, their voice (or mine), roles, voice moderation,
 * kick, ban and "Copiar ID do usuário", each only when it makes sense (userMenuEntries).
 */
export function UserMenu({ member, anchor, onClose, profile }: UserMenuProps) {
  const t = useT();
  const userId = member.userId;
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const openSettings = useUserSettingsOpener((st) => st.open);
  const serverDeafen = useConnectionStore((st) => st.welcome?.serverId === server.serverId && st.welcome.features.includes(FEATURE_VOICE_SERVER_DEAFEN));
  // Their call, as the server on screen reports it.
  const voiceServerId = useVoiceStore((v) => viewVoice(v).serverId);
  const sameServer = voiceServerId !== null && voiceServerId === server.serverId;
  const channelId = useVoiceStore((v) => (sameServer ? (participantIn(viewVoice(v), userId)?.channelId ?? null) : null));
  const participant = useVoiceStore((v) => (sameServer ? (participantIn(viewVoice(v), userId)?.participant ?? null) : null));
  const selfMuted = useVoiceStore((v) => v.selfMuted || v.selfDeafened);
  const selfDeafened = useVoiceStore((v) => v.selfDeafened);
  const locallyMuted = useVoiceSettings((st) => isLocallyMuted(st.settings, voiceServerId, userId));
  const directory = useVoiceDirectory();
  const [dialog, setDialog] = useState<'kick' | 'ban' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One floating thing at a time: the menu replaces an open profile card.
  useEffect(() => useProfileCardStore.getState().close(), []);

  const state = { server, members };
  const isSelf = userId === server.selfId;
  const serverBits = myPermissions(state);
  const above = canActOnMember(state, userId);
  const roles = useMemo(() => (above && has(serverBits, PERMISSIONS.MANAGE_ROLES) ? manageableRoles({ server, members }) : []), [above, serverBits, server, members]);
  const channelBits = channelId === null ? 0 : directory.myPermissions(channelId);
  const targets = channelId !== null && has(channelBits, PERMISSIONS.MOVE_MEMBERS)
    ? directory.voiceChannels().filter((c) => c.id !== channelId && has(directory.myPermissions(c.id), PERMISSIONS.VIEW_CHANNEL))
    : [];
  const entries = userMenuEntries({
    self: isSelf,
    canOpenProfile: profile !== undefined,
    canEditProfile: openSettings !== null,
    voiceChannelId: channelId,
    serverBits,
    channelBits,
    above,
    manageableRoles: roles.length,
    moveTargets: targets.length,
    serverDeafen,
  });

  /** An action that ends the menu. */
  const act = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const toggleRole = async (roleId: string) => {
    setError(null);
    const next = member.roleIds.includes(roleId) ? member.roleIds.filter((id) => id !== roleId) : [...member.roleIds, roleId];
    try {
      await setMemberRoles(userId, next);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  if (dialog === 'kick') {
    const note = server.joinMode === 'invite' ? t('members.kickInviteNote') : t('members.kickOpenNote');
    return (
      <ConfirmDialog
        title={t('members.kick')}
        body={
          <>
            <p className={s.hint}>{t('members.kickConfirm', { name: member.nickname })}</p>
            <p className={server.joinMode === 'invite' ? s.hint : s.warning}>{note}</p>
          </>
        }
        confirmLabel={t('members.kick')}
        onConfirm={() => kickMember(userId)}
        onClose={onClose}
      />
    );
  }
  if (dialog === 'ban') return <BanDialog member={member} onClose={onClose} />;

  const item = (entry: UserMenuEntry, key: number) => {
    switch (entry) {
      case 'separator':
        return <MenuSeparator key={key} />;
      case 'profile':
        return (
          <MenuItem
            key={entry}
            icon={<UserRound size={16} aria-hidden="true" />}
            onSelect={act(() => profile && useProfileCardStore.getState().open(userId, profile.opener.getBoundingClientRect(), profile.side, profile.opener))}
          >
            {t('userMenu.profile')}
          </MenuItem>
        );
      case 'mention':
        return (
          <MenuItem key={entry} icon={<AtSign size={16} aria-hidden="true" />} onSelect={act(() => useComposerStore.getState().requestMention(userCandidate(member)))}>
            {t('members.mention')}
          </MenuItem>
        );
      case 'selfMute':
        return (
          <MenuCheckbox key={entry} checked={selfMuted} onToggle={() => void toggleMute()}>
            {t('voice.mute')}
          </MenuCheckbox>
        );
      case 'selfDeafen':
        return (
          <MenuCheckbox key={entry} checked={selfDeafened} onToggle={() => void toggleDeafen()}>
            {t('voice.deafen')}
          </MenuCheckbox>
        );
      case 'localMute':
        return (
          <MenuCheckbox key={entry} checked={locallyMuted} onToggle={() => setLocalMute(userId, !locallyMuted)}>
            {t('voice.mute')}
          </MenuCheckbox>
        );
      case 'volume':
        return <UserVolume key={entry} userId={userId} />;
      case 'editServerProfile':
        return (
          <MenuItem key={entry} icon={<Pencil size={16} aria-hidden="true" />} onSelect={act(() => openSettings?.())}>
            {t('userMenu.editServerProfile')}
          </MenuItem>
        );
      case 'roles':
        return (
          <MenuSub key={entry} label={t('members.roles')} menuLabel={t('userMenu.rolesOf', { name: member.nickname })}>
            {roles.map((r) => (
              <MenuCheckbox key={r.id} checked={member.roleIds.includes(r.id)} onToggle={() => void toggleRole(r.id)} color={roleColorHex(r.color)}>
                {r.name}
              </MenuCheckbox>
            ))}
            {error && (
              <p className={p.error} role="alert" style={{ padding: '4px 10px' }}>
                {errorMessage(t, error)}
              </p>
            )}
          </MenuSub>
        );
      case 'serverMute':
        return (
          <MenuCheckbox key={entry} danger checked={participant?.serverMuted === true} onToggle={() => void moderateVoice(userId, participant?.serverMuted ? 'unmute' : 'mute')}>
            {t('userMenu.serverMute')}
          </MenuCheckbox>
        );
      case 'serverDeafen':
        return (
          <MenuCheckbox key={entry} danger checked={participant?.serverDeafened === true} onToggle={() => void moderateVoice(userId, participant?.serverDeafened ? 'undeafen' : 'deafen')}>
            {t('userMenu.serverDeafen')}
          </MenuCheckbox>
        );
      case 'move':
        return (
          <MenuSub key={entry} label={t('userMenu.moveTo')} menuLabel={t('userMenu.moveTo')}>
            {targets.map((c) => (
              <MenuItem key={c.id} onSelect={act(() => moderateVoice(userId, 'move', c.id))}>
                {c.name}
              </MenuItem>
            ))}
          </MenuSub>
        );
      case 'disconnect':
        return (
          <MenuItem key={entry} danger icon={<PhoneOff size={16} aria-hidden="true" />} onSelect={act(() => moderateVoice(userId, 'disconnect'))}>
            {t('userMenu.disconnect')}
          </MenuItem>
        );
      case 'kick':
        return (
          <MenuItem key={entry} danger icon={<UserMinus size={16} aria-hidden="true" />} onSelect={() => setDialog('kick')}>
            {t('members.kickName', { name: member.nickname })}
          </MenuItem>
        );
      case 'ban':
        return (
          <MenuItem key={entry} danger icon={<Gavel size={16} aria-hidden="true" />} onSelect={() => setDialog('ban')}>
            {t('members.banName', { name: member.nickname })}
          </MenuItem>
        );
      case 'copyId':
        return (
          <MenuItem key={entry} icon={<IdCard size={16} aria-hidden="true" />} onSelect={act(() => copyUserId(userId).catch(() => undefined))}>
            {t('profileCard.copyId')}
          </MenuItem>
        );
    }
  };

  return (
    <Menu anchor={anchor} label={t('members.menu', { name: member.nickname })} onClose={onClose} width={240}>
      {entries.map(item)}
    </Menu>
  );
}

/** The menu of a member of the server on screen, by id; nothing for someone who is not (or no longer) one. */
export function UserMenuFor({ request, side, onClose }: { request: UserMenuRequest; side: CardSide; onClose: () => void }) {
  const member = useTextStore((st) => (Object.hasOwn(st.members.byId, request.userId) ? st.members.byId[request.userId]! : null));
  if (!member) return null;
  return <UserMenu member={member} anchor={request.anchor} onClose={onClose} profile={{ opener: request.opener, side }} />;
}

function BanDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [banIp, setBanIp] = useState(false);
  return (
    <ConfirmDialog
      title={t('members.ban')}
      body={t('members.banConfirm', { name: member.nickname })}
      confirmLabel={t('members.ban')}
      onConfirm={() => banMember(member.userId, reason, banIp)}
      onClose={onClose}
    >
      <label className={s.field}>
        <span className={s.label}>{t('members.banReason')}</span>
        <input className={s.input} value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className={s.check}>
        <input type="checkbox" checked={banIp} onChange={(e) => setBanIp(e.target.checked)} />
        <span className={s.hint}>{t('members.banIp')}</span>
      </label>
    </ConfirmDialog>
  );
}
