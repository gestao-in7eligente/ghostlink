import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { coreModule } from '../src/coreModule.js';
import type { Db } from '../src/db/database.js';
import { resolveLimits } from '../src/limits.js';
import type { Logger } from '../src/logger.js';
import type { RequestContext } from '../src/modules.js';
import { createDispatcher } from '../src/ws/dispatch.js';

const logger = () => ({ info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() });
const ctx: RequestContext = {
  userId: 'u',
  sessionId: 's',
  now: () => 1234,
  isCurrent: () => true,
  db: {} as Db,
  logger: logger(),
  limits: resolveLimits(),
  dataDir: '/data',
  serverKeyId: 'key',
  sessions: { list: () => [], send: () => false, broadcast: () => 0, closeUser: () => false, isOnlineOrInGrace: () => false, fileToken: () => null },
  getModule: () => {
    throw new Error('no modules');
  },
};
const CORE = coreModule.handlers!;

describe('dispatch', () => {
  it('answers ping with the server time', async () => {
    const dispatch = createDispatcher(CORE, logger());
    expect(await dispatch(ctx, { t: 'ping', id: 7, d: {} })).toEqual({ t: 'res', id: 7, ok: true, d: { t: 1234 } });
    expect(await dispatch(ctx, { t: 'ping', id: 8 })).toEqual({ t: 'res', id: 8, ok: true, d: { t: 1234 } });
  });

  it('rejects a ping payload with unknown keys (strict schemas)', async () => {
    const dispatch = createDispatcher(CORE, logger());
    expect(await dispatch(ctx, { t: 'ping', id: 1, d: { x: 1 } })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('answers unknown types with BAD_REQUEST, including prototype keys', async () => {
    const dispatch = createDispatcher(CORE, logger());
    for (const t of ['msg.send', 'toString', '__proto__', 'constructor', 'hello']) {
      expect(await dispatch(ctx, { t, id: 1 }), t).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'BAD_REQUEST' } });
    }
  });

  it('ignores envelopes without an id', async () => {
    const dispatch = createDispatcher(CORE, logger());
    expect(await dispatch(ctx, { t: 'ping' })).toBeNull();
  });

  it('maps ProtocolError to its code and hides unexpected errors as INTERNAL', async () => {
    const log = logger();
    const dispatch = createDispatcher({
      forbidden: () => {
        throw new ProtocolError('FORBIDDEN', 'nope');
      },
      crash: () => {
        throw new Error('secret internals');
      },
    }, log);
    expect(await dispatch(ctx, { t: 'forbidden', id: 1 })).toEqual({ t: 'res', id: 1, ok: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    const crashed = await dispatch(ctx, { t: 'crash', id: 2 });
    expect(crashed).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'INTERNAL', message: 'INTERNAL' } });
    expect(log.error).toHaveBeenCalledOnce();
  });
});
