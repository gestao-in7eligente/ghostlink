import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@ghostlink/shared';
import { SessionRegistry, type SessionHandle } from '../src/ws/sessions.js';

function handle(userId: string, sessionId: string): SessionHandle & { terminated: ErrorCode[] } {
  const terminated: ErrorCode[] = [];
  return { userId, sessionId, terminated, terminate: (code) => terminated.push(code) };
}

describe('SessionRegistry', () => {
  it('replaces an older session of the same user with SESSION_REPLACED', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u1', 's2');
    r.add(a);
    r.add(b);
    expect(a.terminated).toEqual(['SESSION_REPLACED']);
    expect(b.terminated).toEqual([]);
    expect(r.isCurrent(b)).toBe(true);
    expect(r.isCurrent(a)).toBe(false);
  });

  it('keeps different users independent', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u2', 's2');
    r.add(a);
    r.add(b);
    expect(a.terminated).toEqual([]);
    expect(r.size).toBe(2);
  });

  it('removing a replaced session does not remove its replacement', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    const b = handle('u1', 's2');
    r.add(a);
    r.add(b);
    r.remove(a); // the old socket's close handler runs late
    expect(r.get('u1')).toBe(b);
    r.remove(b);
    expect(r.get('u1')).toBeUndefined();
  });

  it('re-adding the same handle does not terminate it', () => {
    const r = new SessionRegistry();
    const a = handle('u1', 's1');
    r.add(a);
    r.add(a);
    expect(a.terminated).toEqual([]);
  });
});
