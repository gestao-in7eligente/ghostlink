import { useState, type RefObject } from 'react';
import { Check, EllipsisVertical, Search, Users, X } from 'lucide-react';
import type { Friend, FriendsSnapshot } from '../../../shared/friendsTypes.js';
import { GhostMark } from '../../components/GhostMark.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { serverInitials } from '../../layout/names.js';
import { ConfirmDialog, Menu, MenuItem, MenuSeparator, primitives as p } from '../../layout/primitives.js';
import { useFriendsStore } from '../../stores/friends.js';
import { AddFriendPanel } from './AddFriendPanel.js';
import { RenameFriendDialog } from './RenameFriendDialog.js';
import { engineProblem, formatShortCode, friendName, friendsForTab, FRIENDS_TABS, pendingIncoming, type FriendsTab } from './friendsModel.js';
import f from './friends.module.css';

type View = FriendsTab | 'add';
type Ask = { kind: 'rename' | 'remove' | 'block'; friend: Friend } | null;

/**
 * The center of the Home screen, laid out like Discord's Friends page: tabs, the blue
 * "Adicionar amigo", search, and one row per person with round actions.
 */
export function FriendsHome({ nickname, searchRef }: { nickname: string; searchRef: RefObject<HTMLInputElement | null> }) {
  const t = useT();
  const snapshot = useFriendsStore((s) => s.snapshot);
  const loadError = useFriendsStore((s) => s.loadError);
  const [view, setView] = useState<View>('online');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ friend: Friend; anchor: DOMRect } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [error, setError] = useState<string | null>(null);

  const friends = snapshot?.friends ?? [];
  const unnamed = t('friends.unnamed');
  const name = (friend: Friend) => friendName(friend, unnamed);
  const waiting = pendingIncoming(friends);
  const problem = snapshot ? engineProblem(snapshot) : null;

  /** A friends call from a button: failures show above the list instead of being lost. */
  const act = (call: () => Promise<unknown>) => {
    setError(null);
    call().catch((e: unknown) => setError(errorMessage(t, errorCodeOf(e))));
  };
  const run = (call: () => Promise<FriendsSnapshot>) => act(() => useFriendsStore.getState().run(call));

  const body = () => {
    if (!snapshot) return <p className={f.note}>{loadError ? errorMessage(t, loadError) : t('friends.loading')}</p>;
    if (view === 'add') return <AddFriendPanel snapshot={snapshot} />;
    const shown = friendsForTab(friends, view, query, unnamed);
    const nobody = friends.every((x) => x.state !== 'friend');
    // A new person (or nobody online and no friends at all): the welcome, like Discord's empty page.
    if ((view === 'online' || view === 'all') && nobody && query.trim() === '') {
      return (
        <div className={f.welcome}>
          <GhostMark size={96} />
          <h1 className={f.welcomeTitle}>{t('home.welcome', { name: nickname })}</h1>
          <p className={f.welcomeText}>{t('friends.empty.all')}</p>
          <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => setView('add')}>
            {t('friends.add')}
          </button>
        </div>
      );
    }
    return (
      <div className={f.listArea}>
        <label className={f.search}>
          <Search size={18} aria-hidden="true" />
          <input ref={searchRef} type="search" className={f.searchInput} placeholder={t('friends.search')} aria-label={t('friends.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {error && (
          <p className={f.error} role="alert">
            {error}
          </p>
        )}
        <h2 className={f.count}>{t(`friends.count.${view}`, { count: shown.length })}</h2>
        {shown.length === 0 ? (
          <p className={f.note}>{query.trim() !== '' ? t('friends.empty.search') : t(`friends.empty.${view}`)}</p>
        ) : (
          <ul className={f.rows}>
            {shown.map((friend) => (
              <FriendRow
                key={friend.key}
                friend={friend}
                name={name(friend)}
                onAccept={() => run(() => window.ghostlink.friends.accept(friend.key))}
                onDismiss={() => run(() => window.ghostlink.friends.dismiss(friend.key))}
                onMore={(anchor) => setMenu({ friend, anchor })}
              />
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <>
      <header className={f.topbar}>
        <span className={f.topTitle}>
          <Users size={20} aria-hidden="true" />
          {t('friends.title')}
        </span>
        <span className={f.topDot} aria-hidden="true" />
        <div className={f.tabs} role="tablist" aria-label={t('friends.tabs')}>
          {FRIENDS_TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? `${f.tab} ${f.tabSelected}` : f.tab} onClick={() => setView(id)}>
              {t(`friends.tab.${id}`)}
              {id === 'pending' && waiting > 0 && <span className={f.badge}>{waiting}</span>}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={view === 'add'} className={view === 'add' ? `${f.addButton} ${f.addSelected}` : f.addButton} onClick={() => setView('add')}>
            {t('friends.add')}
          </button>
        </div>
      </header>

      {problem && snapshot && (
        <div className={f.banner} role="status">
          <div className={f.bannerText}>
            <strong>{problem === 'off' ? t('friends.off.title') : t('friends.failed.title')}</strong>
            <span>{problem === 'off' ? t('friends.off.text') : t('errors.P2P_UNAVAILABLE')}</span>
          </div>
          <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => run(() => window.ghostlink.friends.setAvailable(true))}>
            {problem === 'off' ? t('friends.off.turnOn') : t('friends.failed.retry')}
          </button>
        </div>
      )}

      {body()}

      {menu && (
        <Menu anchor={menu.anchor} label={t('friends.action.more', { name: name(menu.friend) })} align="end" onClose={() => setMenu(null)}>
          {menu.friend.state === 'friend' && (
            <>
              <MenuItem
                onSelect={() => {
                  setAsk({ kind: 'rename', friend: menu.friend });
                  setMenu(null);
                }}
              >
                {t('friends.action.rename')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  setAsk({ kind: 'remove', friend: menu.friend });
                  setMenu(null);
                }}
              >
                {t('friends.action.remove')}
              </MenuItem>
            </>
          )}
          <MenuItem
            danger
            onSelect={() => {
              setAsk({ kind: 'block', friend: menu.friend });
              setMenu(null);
            }}
          >
            {t('friends.action.block')}
          </MenuItem>
        </Menu>
      )}
      {ask?.kind === 'rename' && <RenameFriendDialog friend={ask.friend} name={name(ask.friend)} onClose={() => setAsk(null)} />}
      {ask?.kind === 'remove' && (
        <ConfirmDialog
          title={t('friends.remove.title', { name: name(ask.friend) })}
          body={t('friends.remove.body')}
          confirmLabel={t('friends.action.remove')}
          onConfirm={() => useFriendsStore.getState().run(() => window.ghostlink.friends.remove(ask.friend.key))}
          onClose={() => setAsk(null)}
        />
      )}
      {ask?.kind === 'block' && (
        <ConfirmDialog
          title={t('friends.block.title', { name: name(ask.friend) })}
          body={t('friends.block.body')}
          confirmLabel={t('friends.action.block')}
          onConfirm={() => useFriendsStore.getState().run(() => window.ghostlink.friends.block(ask.friend.key))}
          onClose={() => setAsk(null)}
        />
      )}
    </>
  );
}

function FriendRow({ friend, name, onAccept, onDismiss, onMore }: { friend: Friend; name: string; onAccept: () => void; onDismiss: () => void; onMore: (anchor: DOMRect) => void }) {
  const t = useT();
  const code = formatShortCode(friend.shortCode);
  const status =
    friend.state === 'friend'
      ? t(friend.online ? 'friends.status.online' : 'friends.status.offline')
      : friend.state === 'pending_in'
        ? t('friends.status.pendingIn', { code })
        : friend.state === 'pending_out'
          ? t('friends.status.pendingOut', { code })
          : t('friends.status.blocked', { code });
  return (
    <li className={f.row}>
      <span className={f.avatar} aria-hidden="true">
        {serverInitials(name)}
        {friend.state === 'friend' && <span className={friend.online ? `${f.dot} ${f.dotOn}` : f.dot} />}
      </span>
      <span className={f.rowText}>
        <span className={f.rowName}>{name}</span>
        <span className={f.rowSub}>{status}</span>
      </span>
      <div className={f.rowActions}>
        {friend.state === 'pending_in' && (
          <button type="button" className={`${f.roundButton} ${f.accept}`} onClick={onAccept} aria-label={`${t('friends.action.accept')}: ${name}`} title={t('friends.action.accept')}>
            <Check size={18} aria-hidden="true" />
          </button>
        )}
        {friend.state !== 'friend' && (
          <button
            type="button"
            className={`${f.roundButton} ${f.decline}`}
            onClick={onDismiss}
            aria-label={`${t(dismissLabel(friend))}: ${name}`}
            title={t(dismissLabel(friend))}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
        {friend.state !== 'blocked' && friend.state !== 'pending_out' && (
          <button
            type="button"
            className={f.roundButton}
            aria-haspopup="menu"
            aria-label={t('friends.action.more', { name })}
            title={t('friends.action.more', { name })}
            onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())}
          >
            <EllipsisVertical size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

/** What the "×" does for a row that is not a friendship yet. */
function dismissLabel(friend: Friend): 'friends.action.decline' | 'friends.action.cancel' | 'friends.action.unblock' {
  if (friend.state === 'pending_in') return 'friends.action.decline';
  return friend.state === 'pending_out' ? 'friends.action.cancel' : 'friends.action.unblock';
}
