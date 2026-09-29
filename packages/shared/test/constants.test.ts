import { describe, expect, it } from 'vitest';
import { APP_ID, CRYPTO_LABELS, DEFAULT_PORT, LIMITS, PROTOCOL } from '../src/index.js';

describe('frozen constants (spec §3.6)', () => {
  it('keeps the cryptographic domain strings byte-for-byte', () => {
    // Changing any of these breaks every existing identity, signature or invite.
    expect(CRYPTO_LABELS).toEqual({
      identitySalt: 'ghostlink/identity/v1',
      authPrefix: 'ghostlink-auth-v1',
      fileHmac: 'ghostlink-file-v1',
      keyFileMagic: 'GLKEY',
      pastePrefix: 'GL1-',
      scheme: 'ghostlink',
    });
    expect(APP_ID).toBe('app.ghostlink.desktop');
  });

  it('keeps protocol and port defaults consistent', () => {
    expect(PROTOCOL.min).toBeLessThanOrEqual(PROTOCOL.current);
    expect(PROTOCOL.current).toBeLessThanOrEqual(PROTOCOL.max);
    expect(DEFAULT_PORT).toBe(7700);
  });

  it('matches the spec §13 limits', () => {
    expect(LIMITS).toMatchObject({
      maxPayloadBytes: 262_144,
      helloTimeoutMs: 5_000,
      proofTimeoutMs: 10_000,
      challengeTtlMs: 30_000,
      maxUnauthenticatedConnections: 256,
      maxConnectionsPerIp: 20,
      tlsHandshakeTimeoutMs: 10_000,
      maxSockets: 4_096,
      maxSocketsPerIp: 64,
      authFailuresPerIpPerMinute: 10,
      pendingChallengesPerIp: 5,
      newIdentitiesPerIpPerHour: 5,
      requestsPerSecondPerSession: 30,
      nicknameMaxVisible: 32,
      inviteMaxAddresses: 8,
      inviteMaxLength: 2048,
    });
  });
});
