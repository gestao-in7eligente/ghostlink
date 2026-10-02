import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, Ellipsis, IdCard, Plus, X } from 'lucide-react';
import { roleColorHex, type Member } from '@ghostlink/shared';
import { DM_TEXT_MAX } from '../../../shared/dmTypes.js';
import { avatarUrl } from '../../../shared/profileTypes.js';
import { DEFAULT_LOCALE, errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { Avatar, Menu, MenuItem, primitives as p } from '../../layout/primitives.js';
import { useFriendsStore } from '../../stores/friends.js';
import { avatarHashFor, useMyAvatar } from '../../stores/profile.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { BotTag } from '../bots/BotParts.js';
import { useComposerStore } from '../chat/composerStore.js';
import { userCandidate } from '../chat/mentions.js';
import m from '../members/members.module.css';
import s from './profileCard.module.css';
import { CARD_MARGIN, averageColor, cardRoles, formatMemberSince, friendOf, placeCard } from './profileCardModel.js';
import { changeRole, copyUserId, messageFriend, useProfileCardStore, type OpenCard } from './profileCardStore.js';

/**
 * The open profile card, if any (spec 2026-10-02-cartao-de-perfil). One for the whole server
 * screen: leaving the server, or the person leaving it, closes it.
 */
export function ProfileCardHost() {
  const card = useProfileCardStore((st) => st.card);
  const serverId = useTextStore((st) => st.server.serverId);
  const member = useTextStore((st) => (card !== null && Object.hasOwn(st.members.byId, card.userId) ? st.members.byId[card.userId]! : null));
  const stale = card !== null && (member === null || card.serverId !== serverId);

  useEffect(() => {
    if (stale) useProfileCardStore.getState().close();
  }, [stale]);
  useEffect(() => () => useProfileCardStore.getState().close(), []);

  if (card === null || member === null || stale) return null;
  return <ProfileCard key={card.id} card={card} member={member} />;
}

// ---- the banner's color ----

/** The photo is shrunk to this square before averaging: plenty for one color. */
const SAMPLE = 16;
/** Photo hash → its mean color. Only colors are kept: a photo that failed may load next time. */
const bannerColors = new Map<string, string>();

/** The photo's mean color (app:// is the page's own origin, so the canvas can be read); null when it does not load. */
function readBannerColor(hash: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        resolve(averageColor(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = avatarUrl(hash);
  });
}

/** The banner's background (spec §2 item 1): the photo's mean color, the initials' blurple without one, and a neutral gray while reading it. */
function useBannerBackground(hash: string | null): string {
  const [read, setRead] = useState<{ hash: string; color: string | null } | null>(null);
  useEffect(() => {
    if (hash === null || bannerColors.has(hash)) return;
    let alive = true;
    void readBannerColor(hash).then((color) => {
      if (color !== null) bannerColors.set(hash, color);
      if (alive) setRead({ hash, color });
    });
    return () => {
      alive = false;
    };
  }, [hash]);
  if (hash === null) return 'var(--accent)';
  const color = bannerColors.get(hash) ?? (read?.hash === hash ? read.color : undefined);
  if (color === undefined) return 'var(--bg-hover)';
  return color ?? 'var(--accent)';
}

// ---- the card ----

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type CardMenu = { kind: 'more' | 'roles'; anchor: DOMRect } | null;
type CardError = { where: 'roles' | 'message'; code: string } | null;

function ProfileCard({ card, member }: { card: OpenCard; member: Member }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? DEFAULT_LOCALE);
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const friends = useFriendsStore((st) => st.snapshot);
  const ref = useRef<HTMLDivElement>(null);
  const rolesHeading = useId();
  const sinceHeading = useId();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [menu, setMenu] = useState<CardMenu>(null);
  const [error, setError] = useState<CardError>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');

  const isSelf = member.userId === server.selfId;
  const isOwner = server.ownerId !== null && member.userId === server.ownerId;
  const roles = useMemo(() => cardRoles({ server, members }, member), [server, members, member]);
  const friend = isSelf ? null : friendOf(friends, member.userId);
  const mine = useMyAvatar(isSelf);
  const banner = useBannerBackground(avatarHashFor(isSelf, member.avatar, mine));
  const since = formatMemberSince(member.joinedAt, locale);
  const close = () => useProfileCardStore.getState().close();

  // Home keeps the friends list in step only while it is on screen: ask main again as the card opens.
  useEffect(() => {
    if (!isSelf && !member.bot) void useFriendsStore.getState().load();
    // Once per card.
  }, []);

  // Beside the name or row, inside the window, and again whenever the card changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const next = placeCard(card.anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, card.side);
      setPos((prev) => (prev !== null && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [card]);

  // The focus moves into the card as it opens, and back to the name, picture or row as it closes.
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (card.opener?.isConnected) card.opener.focus();
    };
  }, [card]);

  // A focused chip that went away (a role taken, the last one given) leaves the focus in the card.
  useLayoutEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) ref.current?.focus({ preventScroll: true });
  });

  // A click outside, Esc or a resized window closes it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || ref.current?.contains(target)) return;
      // Its own menus float outside it; a click on a name, picture or row decides on its own
      // (another person's card, or this one closing again).
      if (target.closest('[role="menu"]') || (e.button === 0 && target.closest('[data-profile-trigger]'))) return;
      useProfileCardStore.getState().close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) useProfileCardStore.getState().close();
    };
    const onResize = () => useProfileCardStore.getState().close();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  /** Esc closes; Tab goes round the card's controls. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = ref.current;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !root) return;
    const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const toggleRole = async (roleId: string, give: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await changeRole(member, roleId, give);
    } catch (e) {
      setError({ where: 'roles', code: errorCodeOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (friend === null || busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await messageFriend(friend.key, text);
      close();
    } catch (e) {
      setError({ where: 'message', code: errorCodeOf(e) });
      setBusy(false);
    }
  };

  const errorLine = (where: 'roles' | 'message') =>
    error?.where === where && (
      <p className={s.error} role="alert">
        {errorMessage(t, error.code)}
      </p>
    );

  const style: CSSProperties = pos
    ? { left: pos.left, top: `max(calc(var(--titlebar-h) + ${CARD_MARGIN}px), ${pos.top}px)` }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div ref={ref} className={s.card} role="dialog" aria-label={t('profileCard.label', { name: member.nickname })} tabIndex={-1} style={style} onKeyDown={onKeyDown}>
      <div className={s.top}>
        <div className={s.banner} style={{ background: banner }} />
        <button
          type="button"
          className={s.more}
          aria-label={t('profileCard.more')}
          title={t('profileCard.more')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'more'}
          onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget.getBoundingClientRect() })}
        >
          <Ellipsis size={18} aria-hidden="true" />
        </button>
        <span className={s.picture}>
          <Avatar size={80} name={member.nickname} hash={member.avatar} self={isSelf} online={member.online} />
        </span>
      </div>

      <div className={s.body}>
        <div className={s.nameLine}>
          <h2 className={s.name}>{member.nickname}</h2>
          {member.bot && <BotTag t={t} />}
          {isSelf && <span className={`${m.badge} ${m.badgeAccent}`}>{t('members.you')}</span>}
          {isOwner && <span className={`${m.badge} ${m.badgeAccent}`}>{t('members.owner')}</span>}
        </div>

        {since !== null && (
          <section className={s.section} aria-labelledby={sinceHeading}>
            <h3 id={sinceHeading} className={s.heading}>
              {t('profileCard.memberSince')}
            </h3>
            <p className={s.value}>{since}</p>
          </section>
        )}

        {(roles.roles.length > 0 || roles.addable.length > 0) && (
          <section className={s.section} aria-labelledby={rolesHeading}>
            <h3 id={rolesHeading} className={s.heading}>
              {t('members.roles')}
            </h3>
            <ul className={s.roles}>
              {roles.roles.map((r) => {
                const color = roleColorHex(r.color);
                return (
                  <li key={r.id} className={s.chip} style={color ? ({ '--role': color } as CSSProperties) : undefined}>
                    {roles.removable.has(r.id) ? (
                      <button
                        type="button"
                        className={s.chipRemove}
                        aria-label={t('profileCard.removeRole', { role: r.name })}
                        title={t('profileCard.removeRole', { role: r.name })}
                        onClick={() => void toggleRole(r.id, false)}
                      >
                        <X size={10} strokeWidth={3.5} aria-hidden="true" />
                      </button>
                    ) : (
                      <span className={s.chipDot} aria-hidden="true" />
                    )}
                    <span className={s.chipName}>{r.name}</span>
                  </li>
                );
              })}
              {roles.addable.length > 0 && (
                <li>
                  <button
                    type="button"
                    className={s.addRole}
                    aria-label={t('profileCard.addRole')}
                    title={t('profileCard.addRole')}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'roles'}
                    onClick={(e) => setMenu({ kind: 'roles', anchor: e.currentTarget.getBoundingClientRect() })}
                  >
                    <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                </li>
              )}
            </ul>
            {errorLine('roles')}
          </section>
        )}

        {friend !== null && (
          <>
            <input
              className={s.message}
              value={text}
              maxLength={DM_TEXT_MAX}
              placeholder={t('dm.placeholder', { name: member.nickname })}
              aria-label={t('dm.placeholder', { name: member.nickname })}
              readOnly={busy}
              aria-busy={busy}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                if (error?.where === 'message') setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                void send();
              }}
            />
            {errorLine('message')}
          </>
        )}
      </div>

      {menu?.kind === 'more' && (
        <Menu anchor={menu.anchor} label={t('profileCard.more')} onClose={() => setMenu(null)} align="end" width={220}>
          <MenuItem
            icon={<AtSign size={16} aria-hidden="true" />}
            onSelect={() => {
              useComposerStore.getState().requestMention(userCandidate(member));
              close();
            }}
          >
            {t('members.mention')}
          </MenuItem>
          <MenuItem
            icon={<IdCard size={16} aria-hidden="true" />}
            onSelect={() => {
              void copyUserId(member.userId).catch(() => undefined);
              setMenu(null);
            }}
          >
            {t('profileCard.copyId')}
          </MenuItem>
        </Menu>
      )}
      {menu?.kind === 'roles' && (
        <Menu anchor={menu.anchor} label={t('profileCard.addRoleTo', { name: member.nickname })} onClose={() => setMenu(null)} width={220}>
          {roles.addable.map((r) => {
            const color = roleColorHex(r.color);
            return (
              <MenuItem
                key={r.id}
                onSelect={() => {
                  setMenu(null);
                  void toggleRole(r.id, true);
                }}
              >
                <span className={p.roleDot} style={color ? { background: color } : undefined} aria-hidden="true" />
                {r.name}
              </MenuItem>
            );
          })}
        </Menu>
      )}
    </div>,
    document.body,
  );
}
