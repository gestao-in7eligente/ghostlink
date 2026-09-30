import { describe, expect, it } from 'vitest';
import { PER_ADDRESS, SHARED_ADDRESS, SHARED_ADDRESS_KEY, SlidingWindowLimiter, ipKey } from '../src/ratelimit/limiter.js';

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window and then refuses', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(3, 1_000, () => clock.t);
    expect([l.hit('k'), l.hit('k'), l.hit('k'), l.hit('k')]).toEqual([true, true, true, false]);
    expect(l.hit('other')).toBe(true);
  });

  it('slides: each hit expires exactly windowMs after it happened', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(2, 1_000, () => clock.t);
    l.hit('k');
    clock.t = 500;
    l.hit('k');
    clock.t = 999;
    expect(l.peek('k')).toBe(false);
    clock.t = 1_000;
    expect(l.peek('k')).toBe(true); // the t=0 hit left the window
    expect(l.hit('k')).toBe(true);
    expect(l.hit('k')).toBe(false); // t=500 still inside
  });

  it('peek never records and refused hits are not recorded', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(1, 1_000, () => clock.t);
    for (let i = 0; i < 5; i++) expect(l.peek('k')).toBe(true);
    expect(l.hit('k')).toBe(true);
    expect(l.hit('k')).toBe(false);
    clock.t = 1_000;
    expect(l.hit('k')).toBe(true);
  });

  it('sweep forgets idle keys', () => {
    const clock = { t: 0 };
    const l = new SlidingWindowLimiter(5, 1_000, () => clock.t);
    for (let i = 0; i < 100; i++) l.hit(`k${i}`);
    expect(l.size).toBe(100);
    clock.t = 5_000;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe('ipKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:0:0:ffff::2', '2001:db8:0:0::/64'],
    ['2001:0DB8:0000:0000:1:2:3:4', '2001:db8:0:0::/64'],
    ['2001:db8:0:1::1', '2001:db8:0:1::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['[2001:db8::9]', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s → %s', (input, key) => {
    expect(ipKey(input)).toBe(key);
  });

  it('groups a whole /64 together but separates neighbouring /64s', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe(ipKey('2001:db8:1:2:bbbb::ffff'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
  });

  it('passes unknown formats through unchanged', () => {
    expect(ipKey('unknown')).toBe('unknown');
  });
});

describe('client addressing (spec §13)', () => {
  it('per address: the same keys as ipKey, and the address is real', () => {
    expect(PER_ADDRESS.real).toBe(true);
    expect(PER_ADDRESS.keyOf('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(PER_ADDRESS.keyOf('2001:db8:1:2::9')).toBe(ipKey('2001:db8:1:2::9'));
  });

  it('behind a proxy: one key for everyone, and the address is not the client\'s', () => {
    expect(SHARED_ADDRESS.real).toBe(false);
    expect(SHARED_ADDRESS.keyOf('100.64.0.2')).toBe(SHARED_ADDRESS.keyOf('100.64.0.3'));
    expect(SHARED_ADDRESS.keyOf('::1')).toBe(SHARED_ADDRESS_KEY);
  });
});
