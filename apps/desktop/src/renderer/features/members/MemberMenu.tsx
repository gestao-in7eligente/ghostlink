import { useMemo, useState } from 'react';
import { AtSign, Gavel, IdCard, UserMinus } from 'lucide-react';
import { PERMISSIONS, has, roleColorHex, type Member } from '@ghostlink/shared';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { ConfirmDialog, Menu, MenuCheckbox, MenuHeading, MenuItem, MenuSeparator, primitives as p, type MenuAnchor } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useLayoutSlots } from '../../layout/slots.js';
import { canActOnMember, manageableRoles, myPermissions } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { banMember, kickMember, setMemberRoles } from '../chat/actions.js';
import { useComposerStore } from '../chat/composerStore.js';
import { userCandidate } from '../chat/mentions.js';
import { copyUserId } from '../profileCard/profileCardStore.js';

/** A member's context menu: mention, roles, kick, ban (spec §11.1 item 4, per permission and hierarchy) and "Copiar ID do usuário". */
export function MemberMenu({ member, anchor, onClose }: { member: Member; anchor: MenuAnchor; onClose: () => void }) {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const Extras = useLayoutSlots((st) => st.MemberMenuExtras);
  const [dialog, setDialog] = useState<'kick' | 'ban' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = { server, members };
  const bits = myPermissions(state);
  const above = canActOnMember(state, member.userId);
  const canKick = above && has(bits, PERMISSIONS.KICK_MEMBERS);
  const canBan = above && has(bits, PERMISSIONS.BAN_MEMBERS);
  const roles = useMemo(() => (above && has(bits, PERMISSIONS.MANAGE_ROLES) ? manageableRoles({ server, members }) : []), [above, bits, server, members]);

  const toggleRole = async (roleId: string) => {
    setError(null);
    const next = member.roleIds.includes(roleId) ? member.roleIds.filter((id) => id !== roleId) : [...member.roleIds, roleId];
    try {
      await setMemberRoles(member.userId, next);
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
        onConfirm={() => kickMember(member.userId)}
        onClose={onClose}
      />
    );
  }
  if (dialog === 'ban') return <BanDialog member={member} onClose={onClose} />;

  return (
    <Menu anchor={anchor} label={t('members.menu', { name: member.nickname })} onClose={onClose} width={240}>
      <MenuItem
        icon={<AtSign size={16} aria-hidden="true" />}
        onSelect={() => {
          useComposerStore.getState().requestMention(userCandidate(member));
          onClose();
        }}
      >
        {t('members.mention')}
      </MenuItem>
      {Extras && <Extras userId={member.userId} close={onClose} />}
      {roles.length > 0 && (
        <>
          <MenuSeparator />
          <MenuHeading>{t('members.roles')}</MenuHeading>
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
        </>
      )}
      {(canKick || canBan) && <MenuSeparator />}
      {canKick && (
        <MenuItem danger icon={<UserMinus size={16} aria-hidden="true" />} onSelect={() => setDialog('kick')}>
          {t('members.kickName', { name: member.nickname })}
        </MenuItem>
      )}
      {canBan && (
        <MenuItem danger icon={<Gavel size={16} aria-hidden="true" />} onSelect={() => setDialog('ban')}>
          {t('members.banName', { name: member.nickname })}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<IdCard size={16} aria-hidden="true" />}
        onSelect={() => {
          void copyUserId(member.userId).catch(() => undefined);
          onClose();
        }}
      >
        {t('profileCard.copyId')}
      </MenuItem>
    </Menu>
  );
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
