import { describe, expect, it } from 'vitest';
import { LIMITS } from '@ghostlink/shared';
import { SERVER_LIMITS, SHARED_ADDRESS_LIMITS, resolveLimits } from '../src/limits.js';

describe('resolveLimits', () => {
  it('the shared LIMITS plus the server-only ones, overrides last', () => {
    expect(resolveLimits()).toEqual({ ...LIMITS, ...SERVER_LIMITS });
    expect(resolveLimits({ maxSockets: 3 }).maxSockets).toBe(3);
  });

  it('behind a proxy (one address for everyone), the per-IP limits are sized for a whole server (spec §13)', () => {
    const l = resolveLimits(undefined, { sharedAddress: true });
    expect(l.maxSocketsPerIp).toBe(LIMITS.maxSockets);
    expect(l.maxConnectionsPerIp).toBe(LIMITS.maxUnauthenticatedConnections);
    expect(l.pendingChallengesPerIp).toBe(LIMITS.maxUnauthenticatedConnections);
    expect(l.authFailuresPerIpPerMinute).toBe(100);
    expect(l.newIdentitiesPerIpPerHour).toBe(30);
    expect(l).toMatchObject(SHARED_ADDRESS_LIMITS);
    // Everything else stays, and a test override still wins.
    expect(l.maxSockets).toBe(LIMITS.maxSockets);
    expect(resolveLimits({ newIdentitiesPerIpPerHour: 2 }, { sharedAddress: true }).newIdentitiesPerIpPerHour).toBe(2);
  });
});
