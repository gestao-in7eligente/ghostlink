import { ERROR_CODES, isErrorCode, type ErrorCode } from '@ghostlink/shared';

/**
 * Failures the desktop detects by itself. A server never sends these; they share
 * the `errors.<CODE>` i18n namespace with the server's ErrorCode.
 */
export const CLIENT_ERROR_CODES = [
  'PIN_MISMATCH', // the TLS key does not match the pinned serverKeyId
  'UNREACHABLE', // no address answered in time
  'CONNECTION_LOST', // the socket closed before the operation finished
  'TIMEOUT', // the server stopped answering mid-handshake or mid-request
  'SERVER_OUTDATED', // PROTOCOL_UNSUPPORTED because the server is older than this app
  'ENCRYPTION_UNAVAILABLE', // safeStorage cannot encrypt on this system
  'IDENTITY_UNAVAILABLE', // there is no usable identity (missing or locked)
  // Host mode (spec §9, §8.5); messages in i18n/<locale>/host.ts.
  'PORT_IN_USE', // another program already listens on the chosen port
  'HOST_NOT_RUNNING', // the command needs the hosted server running
  'HOST_BUSY', // the hosted server is starting or stopping
  'HOST_FAILED', // the hosted server could not start, or stopped by itself
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type AppErrorCode = ErrorCode | ClientErrorCode;

export const APP_ERROR_CODES: readonly AppErrorCode[] = [...ERROR_CODES, ...CLIENT_ERROR_CODES];

const CLIENT_ERROR_SET: ReadonlySet<string> = new Set<string>(CLIENT_ERROR_CODES);

export function isAppErrorCode(x: unknown): x is AppErrorCode {
  return isErrorCode(x) || (typeof x === 'string' && CLIENT_ERROR_SET.has(x));
}

/** A failure detected in the main process, carrying a code the renderer can translate. */
export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

/**
 * The code the renderer may see for any thrown value. Anything without a known
 * code (Node errors such as ECONNREFUSED, bugs) becomes INTERNAL, so internal
 * messages never cross the IPC boundary.
 */
export function toAppErrorCode(e: unknown): AppErrorCode {
  if (typeof e === 'object' && e !== null && 'code' in e && isAppErrorCode(e.code)) return e.code;
  return 'INTERNAL';
}
