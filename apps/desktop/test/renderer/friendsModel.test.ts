import { describe, expect, it } from 'vitest';
import { normalizeFriendCode, type Friend, type FriendsSnapshot } from '../../src/shared/friendsTypes.js';
import { engineProblem, formatShortCode, friendName, friendsForTab, newerSnapshot, pendingIncoming } from '../../src/renderer/features/friends/friendsModel.js';

const friend = (key: string, over: Partial<Friend> = {}): Friend => ({
  key,
  userId: key.padEnd(32, '0'),
  shortCode: `${key.toUpperCase()}AAAAAAA`.slice(0, 8),
  nickname: key,
  localName: null,
  state: 'friend',
  online: false,
  since: 1,
  ...over,
});

const snapshot = (over: Partial<FriendsSnapshot> = {}): FriendsSnapshot => ({ revision: 1, running: true, available: true, code: 'GLF1-X', inboxEnabled: true, friends: [], ...over });

describe('friend names', () => {
  it('prefers the local nickname, then theirs, then the stand-in', () => {
    expect(friendName(friend('bia', { localName: 'Bibi' }), '?')).toBe('Bibi');
    expect(friendName(friend('bia'), '?')).toBe('bia');
    expect(friendName(friend('bia', { nickname: '' }), 'Sem nome')).toBe('Sem nome');
  });

  it('groups the short code like the full code', () => {
    expect(formatShortCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('Friends page lists', () => {
  const list = [
    friend('zeca'),
    friend('ana', { online: true }),
    friend('Érica', { online: true }),
    friend('novo', { state: 'pending_out', since: 5 }),
    friend('quer', { state: 'pending_in', since: 3 }),
    friend('quer2', { state: 'pending_in', since: 9 }),
    friend('chato', { state: 'blocked' }),
  ];
  const keys = (rows: Friend[]) => rows.map((f) => f.key);

  it('puts each person in the right tab', () => {
    expect(keys(friendsForTab(list, 'online', '', '?'))).toEqual(['ana', 'Érica']);
    expect(keys(friendsForTab(list, 'all', '', '?'))).toEqual(['ana', 'Érica', 'zeca']);
    expect(keys(friendsForTab(list, 'blocked', '', '?'))).toEqual(['chato']);
  });

  it('lists requests to answer first, newest first, then the ones sent', () => {
    expect(keys(friendsForTab(list, 'pending', '', '?'))).toEqual(['quer2', 'quer', 'novo']);
  });

  it('searches names without case or accents, and short codes with or without the dash', () => {
    expect(keys(friendsForTab(list, 'all', ' erica ', '?'))).toEqual(['Érica']);
    expect(keys(friendsForTab(list, 'all', 'zeca-aaaa', '?'))).toEqual(['zeca']);
    expect(friendsForTab(list, 'all', 'ninguem', '?')).toEqual([]);
  });

  it('counts only the requests waiting for an answer', () => {
    expect(pendingIncoming(list)).toBe(2);
  });
});

describe('engine state and snapshots', () => {
  it('tells off from failed', () => {
    expect(engineProblem(snapshot())).toBeNull();
    expect(engineProblem(snapshot({ running: false, available: false }))).toBe('off');
    expect(engineProblem(snapshot({ running: false, available: true }))).toBe('failed');
  });

  it('never goes back to an older snapshot', () => {
    const newer = snapshot({ revision: 7 });
    expect(newerSnapshot(newer, snapshot({ revision: 3 }))).toBe(newer);
    const next = snapshot({ revision: 8 });
    expect(newerSnapshot(newer, next)).toBe(next);
    expect(newerSnapshot(null, next)).toBe(next);
  });
});

describe('friend code shape (the renderer\'s quick check)', () => {
  const groups = Array.from({ length: 21 }, () => 'ABCD');

  it('accepts a code with or without dashes, in any case, with spaces around', () => {
    expect(normalizeFriendCode(`  glf1-${groups.join('-').toLowerCase()} `)).toBe(`GLF1-${groups.join('-')}`);
    expect(normalizeFriendCode(`GLF1${groups.join('')}`)).toBe(`GLF1${groups.join('')}`);
  });

  it('refuses another prefix, a wrong length and characters outside base32', () => {
    expect(normalizeFriendCode(`GL1-${groups.join('-')}`)).toBeNull();
    expect(normalizeFriendCode(`GLF1-${groups.slice(1).join('-')}`)).toBeNull();
    expect(normalizeFriendCode(`GLF1-${['AB1D', ...groups.slice(1)].join('-')}`)).toBeNull();
    expect(normalizeFriendCode('')).toBeNull();
  });
});
