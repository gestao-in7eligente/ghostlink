import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Lock, Plus } from 'lucide-react';
import {
  PERMISSIONS,
  PERMISSION_NAMES,
  ROLE_LIMITS,
  canManageRole,
  has,
  parseRoleColor,
  roleColorHex,
  type Role,
} from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ConfirmDialog, ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { myPermissions, rolesByPosition, subjectOf } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { createRole, deleteRole, reorderRoles, updateRole, type RoleDraft } from '../chat/actions.js';
import { reorderedRoleIds } from './access.js';

/** Where the color picker starts for a role without color (a value, not a UI color). */
const PICKER_START = '#99aab5';

/** Roles (MANAGE_ROLES): order by dragging, permissions with descriptions, color, hoist, mentionable. */
export function RolesTab() {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const roles = useMemo(() => rolesByPosition(server.roles), [server.roles]);
  const me = useMemo(() => subjectOf(server, members, server.selfId), [server, members]);
  const myBits = useMemo(() => myPermissions({ server, members }), [server, members]);
  const orderable = useMemo(() => roles.filter((r) => !r.isDefault && canManageRole(me, r)), [roles, me]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = roles.find((r) => r.id === selectedId) ?? orderable[0] ?? roles.at(-1) ?? null;

  const reorder = async (id: string, toIndex: number) => {
    const ids = orderable.map((r) => r.id);
    const next = reorderedRoleIds(ids, id, toIndex);
    if (next.every((x, i) => x === ids[i])) return;
    setError(null);
    try {
      await reorderRoles(next);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  const create = async () => {
    setError(null);
    try {
      const role = await createRole({ name: t('serverSettings.roles.newName') });
      setSelectedId(role.id);
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  const onDrop = (e: DragEvent, target: Role) => {
    e.preventDefault();
    const index = orderable.findIndex((r) => r.id === target.id);
    if (dragId && index >= 0) void reorder(dragId, index);
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className={s.split}>
      <div className={s.field}>
        <p className={s.hint}>{t('serverSettings.roles.dragHint')}</p>
        <ul className={s.list} aria-label={t('serverSettings.tab.roles')}>
          {roles.map((r) => {
            const movable = orderable.some((o) => o.id === r.id);
            const color = roleColorHex(r.color);
            return (
              <li
                key={r.id}
                draggable={movable}
                onDragStart={(e) => {
                  setDragId(r.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!dragId || !movable) return;
                  e.preventDefault();
                  setOverId(r.id);
                }}
                onDragLeave={() => setOverId((id) => (id === r.id ? null : id))}
                onDrop={(e) => onDrop(e, r)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                className={[dragId === r.id ? s.itemDragging : '', overId === r.id ? s.itemOver : ''].filter(Boolean).join(' ') || undefined}
              >
                <button
                  type="button"
                  className={selected?.id === r.id ? `${s.roleButton} ${s.roleButtonActive}` : s.roleButton}
                  aria-current={selected?.id === r.id ? 'true' : undefined}
                  onClick={() => setSelectedId(r.id)}
                >
                  {movable ? <GripVertical size={14} className={s.grip} aria-hidden="true" /> : <Lock size={14} className={s.grip} aria-hidden="true" />}
                  <span className={s.roleSwatch} style={color ? { background: color } : undefined} aria-hidden="true" />
                  <span className={s.roleButtonName}>{r.isDefault ? t('chat.everyone') : r.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className={p.button} onClick={() => void create()} disabled={roles.length >= ROLE_LIMITS.maxRoles}>
          <Plus size={16} aria-hidden="true" />
          {t('serverSettings.roles.create')}
        </button>
        {error && <ErrorText code={error} />}
      </div>
      {selected && (
        <RoleEditor
          key={selected.id}
          role={selected}
          manageable={canManageRole(me, selected)}
          myBits={myBits}
          index={orderable.findIndex((r) => r.id === selected.id)}
          count={orderable.length}
          onMove={(toIndex) => void reorder(selected.id, toIndex)}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  manageable,
  myBits,
  index,
  count,
  onMove,
  onDeleted,
}: {
  role: Role;
  manageable: boolean;
  myBits: number;
  index: number;
  count: number;
  onMove: (toIndex: number) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number>(role.color);
  const [bits, setBits] = useState(role.permissions);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // A change from the server (another admin, or our own save) resets the form.
  useEffect(() => {
    setName(role.name);
    setColor(role.color);
    setBits(role.permissions);
    setHoist(role.hoist);
    setMentionable(role.mentionable);
  }, [role]);

  const patch: RoleDraft = {};
  if (!role.isDefault && name.trim() !== role.name) patch.name = name.trim();
  if (!role.isDefault && color !== role.color) patch.color = color;
  if (bits !== role.permissions) patch.permissions = bits;
  if (!role.isDefault && hoist !== role.hoist) patch.hoist = hoist;
  if (!role.isDefault && mentionable !== role.mentionable) patch.mentionable = mentionable;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateRole(role.id, patch);
      setSaved(true);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  const hex = roleColorHex(color);
  return (
    <div className={s.form}>
      {!manageable && <p className={s.warning}>{t('serverSettings.roles.locked')}</p>}
      {role.isDefault ? (
        <p className={s.hint}>{t('serverSettings.roles.everyoneHint')}</p>
      ) : (
        <>
          <label className={s.field}>
            <span className={s.label}>{t('serverSettings.roles.name')}</span>
            <input className={s.input} value={name} maxLength={ROLE_LIMITS.nameMax} disabled={!manageable} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className={s.field}>
            <span className={s.label}>{t('serverSettings.roles.color')}</span>
            <div className={s.row}>
              <input
                type="color"
                className={s.colorInput}
                aria-label={t('serverSettings.roles.color')}
                value={hex ?? PICKER_START}
                disabled={!manageable}
                onChange={(e) => setColor(parseRoleColor(e.target.value) ?? 0)}
              />
              <button type="button" className={`${p.button} ${s.small}`} disabled={!manageable || color === 0} onClick={() => setColor(0)}>
                {t('serverSettings.roles.noColor')}
              </button>
            </div>
          </div>
          <label className={s.perm}>
            <span className={s.permText}>
              <span className={s.permName}>{t('serverSettings.roles.hoist')}</span>
            </span>
            <input type="checkbox" role="switch" className={s.switch} checked={hoist} disabled={!manageable} onChange={(e) => setHoist(e.target.checked)} />
          </label>
          <label className={s.perm}>
            <span className={s.permText}>
              <span className={s.permName}>{t('serverSettings.roles.mentionable')}</span>
            </span>
            <input type="checkbox" role="switch" className={s.switch} checked={mentionable} disabled={!manageable} onChange={(e) => setMentionable(e.target.checked)} />
          </label>
          {manageable && count > 1 && index >= 0 && (
            <div className={s.row}>
              <button type="button" className={`${p.button} ${s.small}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
                <ArrowUp size={14} aria-hidden="true" />
                {t('serverSettings.roles.moveUp')}
              </button>
              <button type="button" className={`${p.button} ${s.small}`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
                <ArrowDown size={14} aria-hidden="true" />
                {t('serverSettings.roles.moveDown')}
              </button>
            </div>
          )}
        </>
      )}
      <div className={s.field}>
        <span className={s.label}>{t('serverSettings.roles.permissions')}</span>
        {PERMISSION_NAMES.map((perm) => {
          const bit = PERMISSIONS[perm];
          const checked = has(bits, bit);
          // Nobody grants a bit they do not have (spec §6); removing is always allowed.
          const disabled = !manageable || (!checked && !has(myBits, bit));
          return (
            <label key={perm} className={s.perm}>
              <span className={s.permText}>
                <span className={s.permName}>{t(`perm.${perm}`)}</span>
                <span className={s.hint}>{t(`perm.${perm}.desc`)}</span>
                {role.isDefault && perm === 'CREATE_INVITES' && <span className={s.hint}>{t('serverSettings.roles.createInvitesHint')}</span>}
              </span>
              <input
                type="checkbox"
                role="switch"
                className={s.switch}
                checked={checked}
                disabled={disabled}
                onChange={(e) => setBits(e.target.checked ? bits | bit : bits & ~bit)}
              />
            </label>
          );
        })}
      </div>
      {error && <ErrorText code={error} />}
      {saved && !dirty && <p className={s.ok}>{t('serverSettings.saved')}</p>}
      <div className={s.row}>
        {!role.isDefault && manageable && (
          <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={() => setDeleting(true)}>
            {t('serverSettings.roles.delete')}
          </button>
        )}
        <span className={s.spacer} />
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled={!manageable || !dirty || busy || (!role.isDefault && name.trim() === '')} onClick={() => void save()}>
          {t('serverSettings.save')}
        </button>
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('serverSettings.roles.delete')}
          body={t('serverSettings.roles.deleteConfirm', { name: role.name })}
          confirmLabel={t('serverSettings.roles.delete')}
          onConfirm={async () => {
            await deleteRole(role.id);
            onDeleted();
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
