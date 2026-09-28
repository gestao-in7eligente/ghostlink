import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ProtocolError } from '@ghostlink/shared';
import { APP_ERROR_CODES, AppError, CLIENT_ERROR_CODES, isAppErrorCode, toAppErrorCode } from '../../src/shared/appErrors.js';
import { IPC, IPC_EVENTS } from '../../src/shared/ipcTypes.js';

describe('IPC channel names (contract §5)', () => {
  it('are exactly the contract channels, named ghostlink:<namespace>.<method>', () => {
    expect(Object.values(IPC).sort()).toEqual([
      'ghostlink:app.info',
      'ghostlink:host.copyText',
      'ghostlink:host.invite',
      'ghostlink:host.join',
      'ghostlink:host.logs',
      'ghostlink:host.recoverOwnership',
      'ghostlink:host.restart',
      'ghostlink:host.start',
      'ghostlink:host.status',
      'ghostlink:host.stop',
      'ghostlink:identity.create',
      'ghostlink:identity.replaceKeepingBackup',
      'ghostlink:identity.retry',
      'ghostlink:identity.status',
      'ghostlink:join.connect',
      'ghostlink:join.parse',
      'ghostlink:join.probe',
      'ghostlink:servers.connect',
      'ghostlink:servers.disconnect',
      'ghostlink:servers.list',
      'ghostlink:servers.remove',
      'ghostlink:settings.get',
      'ghostlink:settings.set',
    ]);
  });

  it('keeps the event channels apart from the invoke channels', () => {
    expect(Object.values(IPC_EVENTS)).toEqual(['ghostlink:event.connectionState', 'ghostlink:event.server', 'ghostlink:event.host']);
    for (const event of Object.values(IPC_EVENTS)) expect(Object.values(IPC)).not.toContain(event);
  });
});

describe('app error codes', () => {
  it('client codes never collide with server codes', () => {
    for (const code of CLIENT_ERROR_CODES) expect(ERROR_CODES as readonly string[]).not.toContain(code);
    expect(new Set(APP_ERROR_CODES).size).toBe(ERROR_CODES.length + CLIENT_ERROR_CODES.length);
  });

  it('isAppErrorCode accepts both families and nothing else', () => {
    expect(isAppErrorCode('PIN_MISMATCH')).toBe(true);
    expect(isAppErrorCode('BANNED')).toBe(true);
    for (const x of ['pin_mismatch', '', 'toString', '__proto__', 1, null, undefined, {}]) {
      expect(isAppErrorCode(x), String(x)).toBe(false);
    }
  });

  it('toAppErrorCode keeps known codes and hides everything else as INTERNAL', () => {
    expect(toAppErrorCode(new ProtocolError('INVITE_REQUIRED'))).toBe('INVITE_REQUIRED');
    expect(toAppErrorCode(new AppError('PIN_MISMATCH'))).toBe('PIN_MISMATCH');
    // Node errors carry codes too; they must not leak (or pass for) app codes.
    expect(toAppErrorCode(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))).toBe('INTERNAL');
    expect(toAppErrorCode(new Error('C:\\Users\\ana\\secret'))).toBe('INTERNAL');
    for (const x of [null, undefined, 'BANNED', 42, { code: '__proto__' }]) expect(toAppErrorCode(x)).toBe('INTERNAL');
  });
});
