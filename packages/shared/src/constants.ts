export const APP_NAME = 'GhostLink';
export const APP_ID = 'app.ghostlink.desktop';
export const DEFAULT_PORT = 7700;
export const PROTOCOL = { min: 1, max: 1, current: 1 } as const;

export const CRYPTO_LABELS = {
  identitySalt: 'ghostlink/identity/v1',
  authPrefix: 'ghostlink-auth-v1',
  fileHmac: 'ghostlink-file-v1',
  keyFileMagic: 'GLKEY',
  pastePrefix: 'GL1-',
  scheme: 'ghostlink',
  // Friends over P2P (v0.3, spec 2026-09-30 §2): the friend seed, the friend code checksum, the inbox key and proof.
  friendSalt: 'ghostlink/friend/v1',
  friendCode: 'ghostlink/friendcode/v1',
  friendInbox: 'ghostlink/inbox/v1',
} as const; // FROZEN — never change (spec §3.6)

export const LIMITS = {
  maxPayloadBytes: 256 * 1024,
  helloTimeoutMs: 5_000,
  proofTimeoutMs: 10_000,
  challengeTtlMs: 30_000,
  pingIntervalMs: 15_000,
  pongTimeoutMs: 30_000,
  presenceGraceMs: 20_000,
  maxUnauthenticatedConnections: 256,
  maxConnectionsPerIp: 20,
  // Raw TCP sockets, before TLS (spec §13): a household behind one NAT has several members,
  // each with a WebSocket, an /rtc socket, file downloads and reconnects.
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
} as const;
