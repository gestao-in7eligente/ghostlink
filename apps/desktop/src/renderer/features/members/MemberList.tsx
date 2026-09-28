import { useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { roleColorHex, type Member, type Role } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { Avatar, type MenuAnchor } from '../../layout/primitives.js';
import { groupMembers, type MemberGroup } from '../../stores/members.js';
import { memberRoles } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { MemberMenu } from './MemberMenu.js';
import m from './members.module.css';

/** Role badges shown next to a name; the rest is summarized as "+N". */
const MAX_BADGES = 2;

/** The right column (spec §11.1 item 4, owner's UI reference). */
export function MemberList() {
  const t = useT();
  const members = useTextStore((s) => s.members.byId);
  const roles = useTextStore((s) => s.server.roles);
  const ownerId = useTextStore((s) => s.server.ownerId);
  const selfId = useTextStore((s) => s.server.selfId);
  const groups = useMemo(() => groupMembers(members, roles), [members, roles]);
  const count = Object.keys(members).length;
  const [menu, setMenu] = useState<{ userId: string; anchor: MenuAnchor } | null>(null);

  const label = (g: MemberGroup) => {
    if (g.kind === 'online') return t('members.online', { count: g.members.length });
    if (g.kind === 'offline') return t('members.offline', { count: g.members.length });
    return `${g.role!.name} — ${g.members.length}`;
  };

  return (
    <div className={m.panel}>
      <header className={m.header}>
        <h2 className={m.title}>{t('members.header', { count })}</h2>
      </header>
      <div className={m.scroll}>
        {groups.map((g) => (
          <section key={g.key} className={m.group} aria-label={label(g)}>
            <h3 className={m.groupTitle}>{label(g)}</h3>
            <ul className={m.list}>
              {g.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  roles={memberRoles(roles, member.roleIds)}
                  isSelf={member.userId === selfId}
                  isOwner={member.userId === ownerId}
                  onMenu={(anchor) => setMenu({ userId: member.userId, anchor })}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {menu && Object.hasOwn(members, menu.userId) && <MemberMenu member={members[menu.userId]!} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}

function MemberRow({
  member,
  roles,
  isSelf,
  isOwner,
  onMenu,
}: {
  member: Member;
  roles: Role[];
  isSelf: boolean;
  isOwner: boolean;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const t = useT();
  const shown = roles.slice(0, MAX_BADGES);
  const hidden = roles.length - shown.length;
  const status = member.online ? t('layout.online') : t('members.statusOffline');
  const describe = [member.nickname, status, isSelf ? t('members.you') : null, isOwner ? t('members.owner') : null, ...roles.map((r) => r.name)]
    .filter(Boolean)
    .join(', ');

  const openAt = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onMenu(e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : e.currentTarget.getBoundingClientRect());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      onMenu(e.currentTarget.getBoundingClientRect());
    }
  };

  return (
    <li className={m.item}>
      <button
        type="button"
        className={member.online ? m.row : `${m.row} ${m.offline}`}
        aria-haspopup="menu"
        aria-label={describe}
        onClick={openAt}
        onContextMenu={openAt}
        onKeyDown={onKeyDown}
      >
        <Avatar size={32} online={member.online} />
        <span className={m.text}>
          <span className={m.nameLine}>
            <span className={m.name}>{member.nickname}</span>
            {isSelf && <span className={`${m.badge} ${m.badgeAccent}`}>{t('members.you')}</span>}
            {isOwner && <span className={`${m.badge} ${m.badgeAccent}`}>{t('members.owner')}</span>}
            {shown.map((r) => {
              const color = roleColorHex(r.color);
              return (
                <span key={r.id} className={color ? `${m.badge} ${m.badgeRole}` : m.badge} style={color ? ({ '--role': color } as CSSProperties) : undefined}>
                  {r.name}
                </span>
              );
            })}
            {hidden > 0 && <span className={m.badge}>+{hidden}</span>}
          </span>
          <span className={m.status}>{status}</span>
        </span>
      </button>
    </li>
  );
}
