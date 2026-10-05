import type { Friend, FriendsSnapshot } from '../../../shared/friendsTypes.js';

/** The lists of the Friends page, as Discord names them. */
export type FriendsTab = 'online' | 'all' | 'pending' | 'blocked';
export const FRIENDS_TABS: readonly FriendsTab[] = ['online', 'all', 'pending', 'blocked'];

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The name shown for a person: the local nickname, else theirs, else a stand-in before first contact. */
export function friendName(friend: Friend, unnamed: string): string {
  return friend.localName ?? (friend.nickname !== '' ? friend.nickname : unnamed);
}

/** "ABCDEFGH" → "ABCD-EFGH", the way the full code groups its characters. */
export function formatShortCode(shortCode: string): string {
  return shortCode.replace(/(.{4})(?=.)/g, '$1-');
}

const inTab: Record<FriendsTab, (f: Friend) => boolean> = {
  online: (f) => f.state === 'friend' && f.online,
  all: (f) => f.state === 'friend',
  pending: (f) => f.state === 'pending_in' || f.state === 'pending_out',
  blocked: (f) => f.state === 'blocked',
};

/**
 * The rows of a tab that match the search (name or short code; case, accents and the
 * code's dash ignored). Friends: online first, then by name. Pending: requests to answer
 * first, newest first.
 */
export function friendsForTab(friends: readonly Friend[], tab: FriendsTab, query: string, unnamed: string): Friend[] {
  const q = fold(query.trim());
  const code = q.replace(/-/g, '');
  const rows = friends.filter(
    (f) => inTab[tab](f) && (q === '' || fold(friendName(f, unnamed)).includes(q) || (code !== '' && f.shortCode.toLowerCase().includes(code))),
  );
  if (tab === 'pending') {
    return rows.sort((a, b) => Number(b.state === 'pending_in') - Number(a.state === 'pending_in') || b.since - a.since);
  }
  return rows.sort((a, b) => Number(b.online) - Number(a.online) || friendName(a, unnamed).localeCompare(friendName(b, unnamed)));
}

/** Requests waiting for this person's answer (the badge on "Amigos" and on "Pendentes"). */
export function pendingIncoming(friends: readonly Friend[]): number {
  return friends.filter((f) => f.state === 'pending_in').length;
}

/**
 * Why the list cannot work right now: 'off' = the person turned availability off,
 * 'failed' = it should be running and is not; null = running.
 */
export function engineProblem(snapshot: FriendsSnapshot): 'off' | 'failed' | null {
  if (snapshot.running) return null;
  return snapshot.available ? 'failed' : 'off';
}

/** Keeps the newest snapshot: IPC answers and pushed events can arrive out of order. */
export function newerSnapshot(current: FriendsSnapshot | null, next: FriendsSnapshot): FriendsSnapshot {
  return current !== null && current.revision > next.revision ? current : next;
}
