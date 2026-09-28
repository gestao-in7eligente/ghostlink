import { describe, expect, it } from 'vitest';
import { ChallengeStore } from '../src/auth/challenges.js';

function store(max = 5) {
  const clock = { t: 1_000 };
  const s = new ChallengeStore({ ttlMs: 30_000, maxPendingPerIp: max, now: () => clock.t });
  return { s, clock };
}

describe('ChallengeStore', () => {
  it('issues a 32-byte base64url nonce, unique per connection', () => {
    const { s } = store();
    const a = s.issue('c1', 'ip')!;
    const b = s.issue('c2', 'ip')!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('is single use', () => {
    const { s } = store();
    const nonce = s.issue('c1', 'ip');
    expect(s.take('c1')).toEqual({ ok: true, nonce });
    expect(s.take('c1')).toEqual({ ok: false, reason: 'missing' });
  });

  it('expires strictly after the TTL of the injected clock', () => {
    const { s, clock } = store();
    s.issue('c1', 'ip');
    clock.t += 30_000;
    expect(s.take('c1').ok).toBe(true);
    s.issue('c2', 'ip');
    clock.t += 30_001;
    expect(s.take('c2')).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a second challenge on the same connection', () => {
    const { s } = store();
    s.issue('c1', 'ip');
    expect(() => s.issue('c1', 'ip')).toThrow();
  });

  it('limits pending challenges per IP and frees slots on take/drop', () => {
    const { s } = store(2);
    expect(s.issue('c1', 'a')).not.toBeNull();
    expect(s.issue('c2', 'a')).not.toBeNull();
    expect(s.issue('c3', 'a')).toBeNull();
    expect(s.issue('c4', 'b')).not.toBeNull(); // other IPs unaffected
    s.take('c1');
    expect(s.issue('c5', 'a')).not.toBeNull();
    s.drop('c2');
    s.drop('c2'); // idempotent
    expect(s.pendingFor('a')).toBe(1);
    s.drop('c5');
    s.drop('c4');
    expect(s.pendingFor('a')).toBe(0);
    expect(s.size).toBe(0);
  });
});
