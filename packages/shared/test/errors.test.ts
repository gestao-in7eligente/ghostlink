import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ProtocolError, isErrorCode } from '../src/index.js';

describe('error codes', () => {
  it('is a closed set without duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('contains every handshake code from spec §3.3', () => {
    for (const code of ['PROTOCOL_UNSUPPORTED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID', 'BAD_SIGNATURE',
      'CHALLENGE_EXPIRED', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'RATE_LIMITED', 'BAD_SETUP_CODE',
      'SESSION_REPLACED', 'SERVER_SHUTDOWN']) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it('isErrorCode rejects anything outside the enum', () => {
    for (const x of ['bad_request', 'BAD_REQUEST ', '', 'toString', '__proto__', 42, null, undefined, {}, ['BAD_REQUEST']]) {
      expect(isErrorCode(x), String(x)).toBe(false);
    }
  });
});

describe('ProtocolError', () => {
  it('carries code, message and extra', () => {
    const e = new ProtocolError('PROTOCOL_UNSUPPORTED', 'too old', { min: 1, max: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProtocolError');
    expect(e.code).toBe('PROTOCOL_UNSUPPORTED');
    expect(e.message).toBe('too old');
    expect(e.extra).toEqual({ min: 1, max: 1 });
  });

  it('defaults the message to the code', () => {
    expect(new ProtocolError('BANNED').message).toBe('BANNED');
  });
});
