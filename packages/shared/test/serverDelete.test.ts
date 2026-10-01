import { describe, expect, it } from 'vitest';
import {
  FEATURE_SERVER_DELETE,
  SERVER_DELETE_LIMITS,
  errorEventSchemaClient,
  isErrorCode,
  serverDeleteResultSchemaClient,
  serverDeleteSchema,
  serverDeleteWelcomeSchemaClient,
  serverDeletingEventSchemaClient,
  serverRestoreSchema,
  serverRestoredEventSchemaClient,
} from '../src/index.js';

const AT = 1_790_000_000_000;

describe('server deletion contract', () => {
  it('names the feature flag and the limits of the spec (§3, §4)', () => {
    expect(FEATURE_SERVER_DELETE).toBe('serverDelete');
    expect(SERVER_DELETE_LIMITS.graceMs).toBe(48 * 3_600_000);
    expect(SERVER_DELETE_LIMITS.perWindow).toBe(5);
    expect(SERVER_DELETE_LIMITS.windowMs).toBe(3_600_000);
    expect(SERVER_DELETE_LIMITS.checkIntervalMs).toBe(60_000);
  });

  it('has the two new error codes', () => {
    expect(isErrorCode('SERVER_DELETING')).toBe(true);
    expect(isErrorCode('SERVER_DELETED')).toBe(true);
  });

  it('server.delete and server.restore take an empty object, strictly', () => {
    expect(serverDeleteSchema.parse({})).toEqual({});
    expect(serverRestoreSchema.parse({})).toEqual({});
    expect(serverDeleteSchema.safeParse({ at: AT }).success).toBe(false);
    expect(serverRestoreSchema.safeParse({ force: true }).success).toBe(false);
  });

  it('client schemas read the response, the events and the welcome field, dropping unknown keys', () => {
    expect(serverDeleteResultSchemaClient.parse({ at: AT, extra: 1 })).toEqual({ at: AT });
    expect(serverDeletingEventSchemaClient.parse({ at: AT, extra: 1 })).toEqual({ at: AT });
    expect(serverRestoredEventSchemaClient.parse({ extra: 1 })).toEqual({});
    expect(serverDeleteWelcomeSchemaClient.parse({ deletingAt: AT })).toEqual({ deletingAt: AT });
    expect(serverDeleteWelcomeSchemaClient.parse({ deletingAt: null })).toEqual({ deletingAt: null });
  });

  it('client schemas refuse a missing or malformed deadline', () => {
    for (const bad of [{}, { at: -1 }, { at: 1.5 }, { at: '1790000000000' }, { at: null }]) {
      expect(serverDeletingEventSchemaClient.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(serverDeleteResultSchemaClient.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(serverDeleteWelcomeSchemaClient.safeParse({}).success).toBe(false);
  });

  it('the error event carries the deadline with SERVER_DELETING', () => {
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'SERVER_DELETING', at: AT } }))
      .toEqual({ t: 'error', d: { code: 'SERVER_DELETING', at: AT } });
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'SERVER_DELETED' } }))
      .toEqual({ t: 'error', d: { code: 'SERVER_DELETED' } });
    expect(errorEventSchemaClient.safeParse({ t: 'error', d: { code: 'SERVER_DELETING', at: -5 } }).success).toBe(false);
  });
});
