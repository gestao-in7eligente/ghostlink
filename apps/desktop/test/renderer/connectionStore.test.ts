import { describe, expect, it } from 'vitest';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';
import { connectionReducer, initialConnection, useConnectionStore, type ConnectionView } from '../../src/renderer/stores/connection.js';

function welcome(serverId: string, sessionId = 'sess-1'): RendererWelcome {
  return {
    serverId,
    address: '127.0.0.1:7700',
    self: { userId: 'a'.repeat(32), nickname: 'Ana', isOwner: false },
    sessionId,
    serverTime: 1,
    server: { name: 'Casa', version: '0.1.0', joinMode: 'invite', serverKeyId: 'k'.repeat(43) },
    features: [],
    protocol: { min: 1, max: 1 },
  };
}

const connected = (serverId = 's1'): ConnectionView => connectionReducer(initialConnection, { type: 'joined', welcome: welcome(serverId) });

describe('connectionReducer', () => {
  it('stores the welcome when a join succeeds', () => {
    expect(connected()).toEqual({ state: 'connected', serverId: 's1', error: null, deletingAt: null, welcome: welcome('s1') });
  });

  it('keeps the snapshot while reconnecting and after a failure, with the error', () => {
    const reconnecting = connectionReducer(connected(), { type: 'state', event: { state: 'reconnecting', serverId: 's1' } });
    expect(reconnecting).toMatchObject({ state: 'reconnecting', error: null, welcome: welcome('s1') });
    const failed = connectionReducer(reconnecting, { type: 'state', event: { state: 'failed', serverId: 's1', error: 'BANNED' } });
    expect(failed).toMatchObject({ state: 'failed', error: 'BANNED', welcome: welcome('s1') });
  });

  it('defaults a failure without a code to CONNECTION_LOST', () => {
    expect(connectionReducer(connected(), { type: 'state', event: { state: 'failed', serverId: 's1' } }).error).toBe('CONNECTION_LOST');
  });

  it('drops the snapshot when disconnected or when another server takes over', () => {
    expect(connectionReducer(connected(), { type: 'state', event: { state: 'idle', serverId: 's1' } })).toEqual({ ...initialConnection, serverId: 's1' });
    expect(connectionReducer(connected(), { type: 'state', event: { state: 'connecting', serverId: 's2' } }).welcome).toBeNull();
  });

  it('clears an old error once a new attempt starts', () => {
    const failed = connectionReducer(connected(), { type: 'state', event: { state: 'failed', serverId: 's1', error: 'TIMEOUT' } });
    expect(connectionReducer(failed, { type: 'state', event: { state: 'connecting', serverId: 's1' } }).error).toBeNull();
  });

  it('replaces the whole snapshot with the welcome of a reconnect (spec §13)', () => {
    const next = connectionReducer(connected(), { type: 'serverEvent', event: { t: 'welcome', d: welcome('s1', 'sess-2') } });
    expect(next.welcome?.sessionId).toBe('sess-2');
  });

  it('ignores unknown events and welcomes for another server', () => {
    const s = connected();
    expect(connectionReducer(s, { type: 'serverEvent', event: { t: 'msg.new', d: {} } })).toBe(s);
    expect(connectionReducer(s, { type: 'serverEvent', event: { t: 'welcome', d: welcome('other') } })).toBe(s);
    expect(connectionReducer(s, { type: 'serverEvent', event: { t: 'welcome', d: null } })).toBe(s);
    expect(connectionReducer(initialConnection, { type: 'serverEvent', event: { t: 'welcome', d: welcome('s1') } })).toBe(initialConnection);
  });
});

describe('useConnectionStore', () => {
  it('applies actions through the reducer', () => {
    const { dispatch } = useConnectionStore.getState();
    dispatch({ type: 'joined', welcome: welcome('s9') });
    dispatch({ type: 'state', event: { state: 'reconnecting', serverId: 's9' } });
    expect(useConnectionStore.getState()).toMatchObject({ state: 'reconnecting', serverId: 's9', welcome: welcome('s9') });
  });
});
