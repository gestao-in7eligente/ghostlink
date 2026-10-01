export const ERROR_CODES = [
  'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'HIERARCHY', 'RATE_LIMITED', 'INTERNAL',
  'PROTOCOL_UNSUPPORTED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID', 'BAD_SIGNATURE',
  'CHALLENGE_EXPIRED', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'BAD_SETUP_CODE',
  'SESSION_REPLACED', 'KICKED', 'SERVER_SHUTDOWN',
  'CHANNEL_FULL', 'FILE_TOO_LARGE', 'IMAGE_TOO_LARGE', 'QUOTA_EXCEEDED', 'BAD_ATTACHMENT', 'OWNER_MUST_TRANSFER',
  // Deleting a server (serverDelete.ts): offline until the deadline (the error event carries `at`), then erased.
  'SERVER_DELETING', 'SERVER_DELETED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && ERROR_CODE_SET.has(x);
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'ProtocolError';
  }
}
