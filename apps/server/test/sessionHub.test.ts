import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorCode } from '@ghostlink/shared';
import { SessionHub } from '../src/ws/sessionHub.js';
import type { SessionHandle } from '../src/ws/sessions.js';

const GRACE_MS = 1_000;

type Handle = SessionHandle & { sent: object[]; terminated: ErrorCode[] };
function handle(userId: string, sessionId: string): Handle {
  const sent: object[] = [];
  const terminated: ErrorCode[] = [];
  return { userId, sessionId, fileToken: `ft-${sessionId}`, sent, terminated, send: (e) => sent.push(e), terminate: (c) => terminated.push(c) };
}

function setup() {
  const calls: unknown[][] = [];
  const hub = new SessionHub({
    graceMs: GRACE_MS,
    hooks: {
      opened: (s) => calls.push(['opened', s.sessionId]),
      closed: (s, i) => calls.push(['closed', s.sessionId, i.reason, i.graceExpired]),
    },
  });
  const open = (h: Handle) => {
    hub.add(h);
    hub.opened(h);
  };
  return { hub, calls, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SessionHub: sessions API', () => {
  it('lists, sends to and broadcasts over current sessions only', () => {
    const { hub, open } = setup();
    const a = handle('u1', 's1');
    const b = handle('u2', 's2');
    open(a);
    open(b);
    expect(hub.list()).toEqual([{ userId: 'u1', sessionId: 's1' }, { userId: 'u2', sessionId: 's2' }]);
    expect(hub.send('s1', { t: 'x' })).toBe(true);
    expect(hub.send('nope', { t: 'x' })).toBe(false);
    expect(a.sent).toEqual([{ t: 'x' }]);
    expect(hub.broadcast({ t: 'all' })).toBe(2);
    expect(hub.broadcast({ t: 'only-u2', d: 1 }, (s) => s.userId === 'u2')).toBe(1);
    expect(a.sent).toEqual([{ t: 'x' }, { t: 'all' }]);
    expect(b.sent).toEqual([{ t: 'all' }, { t: 'only-u2', d: 1 }]);
  });

  it('api exposes only the SessionsApi methods', () => {
    const { hub, open } = setup();
    open(handle('u1', 's1'));
    expect(Object.keys(hub.api).sort()).toEqual(['broadcast', 'closeUser', 'fileToken', 'isOnlineOrInGrace', 'list', 'send']);
    expect(hub.api.list()).toEqual([{ userId: 'u1', sessionId: 's1' }]);
    expect(hub.api.isOnlineOrInGrace('u1')).toBe(true);
  });

  it('the filter decides per recipient and sees only userId and sessionId', () => {
    const { hub, open } = setup();
    open(handle('u1', 's1'));
    open(handle('u2', 's2'));
    const seen: unknown[] = [];
    hub.broadcast({ t: 'x' }, (s) => {
      seen.push(s);
      return false;
    });
    expect(seen).toEqual([{ userId: 'u1', sessionId: 's1' }, { userId: 'u2', sessionId: 's2' }]);
  });

  it('fileToken: the key of the signed file URLs of a current session (spec §7), null once it ended or was replaced', () => {
    const { hub, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    open(handle('u2', 's2'));
    expect(hub.api.fileToken('s1')).toBe('ft-s1');
    expect(hub.api.fileToken('s2')).toBe('ft-s2');
    expect(hub.api.fileToken('nope')).toBeNull();
    open(handle('u2', 's3')); // replaces s2
    expect(hub.api.fileToken('s2')).toBeNull();
    expect(hub.api.fileToken('s3')).toBe('ft-s3');
    hub.ended(a, 'disconnected');
    expect(hub.api.fileToken('s1')).toBeNull(); // in grace, but its URLs stop working
  });

  it('a replaced session disappears at once and ends without grace', () => {
    const { hub, calls, open } = setup();
    const old = handle('u1', 's1');
    const next = handle('u1', 's2');
    open(old);
    open(next);
    expect(old.terminated).toEqual(['SESSION_REPLACED']);
    expect(hub.list()).toEqual([{ userId: 'u1', sessionId: 's2' }]);
    expect(hub.send('s1', { t: 'x' })).toBe(false);
    hub.ended(old, 'SESSION_REPLACED'); // the old socket finishes closing later
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(calls).toEqual([['opened', 's1'], ['opened', 's2'], ['closed', 's1', 'SESSION_REPLACED', false]]);
    expect(hub.isCurrent(next)).toBe(true);
  });
});

describe('SessionHub: presence grace (spec §5.1)', () => {
  it('fires graceExpired=false at once and graceExpired=true when the grace ends', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    hub.ended(a, 'disconnected');
    expect(calls).toEqual([['opened', 's1'], ['closed', 's1', 'disconnected', false]]);
    expect(hub.list()).toEqual([]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(true);
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(calls.at(-1)).toEqual(['closed', 's1', 'disconnected', true]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(false);
  });

  it('a reconnect within the grace cancels the expiry', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    hub.ended(a, 'disconnected');
    vi.advanceTimersByTime(GRACE_MS / 2);
    open(handle('u1', 's2'));
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(calls).toEqual([['opened', 's1'], ['closed', 's1', 'disconnected', false], ['opened', 's2']]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(true);
  });

  it('keeps the grace for server-initiated closes such as RATE_LIMITED', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    hub.ended(a, 'RATE_LIMITED');
    vi.advanceTimersByTime(GRACE_MS);
    expect(calls.slice(1)).toEqual([['closed', 's1', 'RATE_LIMITED', false], ['closed', 's1', 'RATE_LIMITED', true]]);
  });

  it('ended() is idempotent', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    hub.ended(a, 'disconnected');
    hub.ended(a, 'disconnected');
    vi.advanceTimersByTime(GRACE_MS);
    expect(calls).toHaveLength(3);
  });

  it('a session that never opened (welcome failed) fires no hook', () => {
    const { hub, calls } = setup();
    const a = handle('u1', 's1');
    hub.add(a);
    hub.ended(a, 'INTERNAL');
    vi.advanceTimersByTime(GRACE_MS);
    expect(calls).toEqual([]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(false);
  });
});

describe('SessionHub: closeUser', () => {
  it('ends the session now, without grace, firing both hooks before returning', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    expect(hub.closeUser('u1', 'KICKED')).toBe(true);
    expect(a.terminated).toEqual(['KICKED']);
    expect(calls.slice(1)).toEqual([['closed', 's1', 'KICKED', false], ['closed', 's1', 'KICKED', true]]);
    expect(hub.list()).toEqual([]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(false);
    expect(hub.isCurrent(a)).toBe(false);
    hub.ended(a, 'KICKED'); // the socket closes afterwards
    vi.advanceTimersByTime(GRACE_MS);
    expect(calls).toHaveLength(3);
  });

  it('ends a pending grace right away', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    open(a);
    hub.ended(a, 'disconnected');
    expect(hub.closeUser('u1', 'BANNED')).toBe(true);
    expect(calls.at(-1)).toEqual(['closed', 's1', 'BANNED', true]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(false);
    vi.advanceTimersByTime(GRACE_MS);
    expect(calls).toHaveLength(3); // opened, closed(false), closed(true): the timer never fires
  });

  it('returns false for an offline user', () => {
    const { hub, calls } = setup();
    expect(hub.closeUser('ghost', 'KICKED')).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('SessionHub: shutdown', () => {
  it('drops pending graces silently and starts none', () => {
    const { hub, calls, open } = setup();
    const a = handle('u1', 's1');
    const b = handle('u2', 's2');
    open(a);
    open(b);
    hub.ended(b, 'disconnected');
    hub.shutdown();
    hub.ended(a, 'SERVER_SHUTDOWN');
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(calls.slice(2)).toEqual([['closed', 's2', 'disconnected', false], ['closed', 's1', 'SERVER_SHUTDOWN', false]]);
    expect(hub.isOnlineOrInGrace('u1')).toBe(false);
    expect(hub.isOnlineOrInGrace('u2')).toBe(false);
  });
});
