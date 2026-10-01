import { useMemo, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { roleColorHex } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { Avatar, primitives as p, type MenuAnchor } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { byNickname } from '../../stores/members.js';
import { memberRoles } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { fold } from '../chat/mentions.js';
import { MemberMenu } from '../members/MemberMenu.js';

/** Every member with their roles; the menu gives roles, kick and ban (per permission and hierarchy). */
export function MembersTab() {
  const t = useT();
  const members = useTextStore((st) => st.members.byId);
  const roles = useTextStore((st) => st.server.roles);
  const ownerId = useTextStore((st) => st.server.ownerId);
  const selfId = useTextStore((st) => st.server.selfId);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ userId: string; anchor: MenuAnchor } | null>(null);
  const list = useMemo(() => {
    const q = fold(query.trim());
    return Object.values(members)
      .filter((m) => q === '' || fold(m.nickname).includes(q))
      .sort(byNickname);
  }, [members, query]);

  return (
    <div className={s.form}>
      <label className={s.field}>
        <span className={s.label}>{t('serverSettings.members.search')}</span>
        <input className={s.input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul className={s.list}>
        {list.map((m) => (
          <li key={m.userId} className={s.item}>
            <Avatar size={32} name={m.nickname} hash={m.avatar} self={m.userId === selfId} online={m.online} />
            <span className={s.itemMain}>
              <span className={s.itemTitle}>
                {m.nickname}
                {m.userId === ownerId && <span className={s.itemMeta}>· {t('members.owner')}</span>}
              </span>
              <span className={s.itemMeta}>
                {memberRoles(roles, m.roleIds)
                  .map((r) => r.name)
                  .join(', ') || t('serverSettings.members.noRoles')}
              </span>
            </span>
            <span className={s.itemActions}>
              {memberRoles(roles, m.roleIds)
                .slice(0, 3)
                .map((r) => (
                  <span key={r.id} className={s.roleSwatch} style={roleColorHex(r.color) ? { background: roleColorHex(r.color)! } : undefined} title={r.name} />
                ))}
              <button
                type="button"
                className={p.iconButton}
                aria-haspopup="menu"
                aria-label={t('members.menu', { name: m.nickname })}
                title={t('members.menu', { name: m.nickname })}
                onClick={(e) => setMenu({ userId: m.userId, anchor: e.currentTarget.getBoundingClientRect() })}
              >
                <MoreHorizontal size={18} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {menu && Object.hasOwn(members, menu.userId) && <MemberMenu member={members[menu.userId]!} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
