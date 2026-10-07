import { create } from 'zustand';
import type { Envelope } from '@ghostlink/shared';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { ConnState, ConnectionStateEvent, RendererWelcome } from '../../shared/ipcTypes.js';

/**
 * The server on screen (spec §11.2). During a voice call another server's connection may
 * live on in the background (chamada-continua §2): its states arrive marked `background`
 * and never land here; the voice runtime follows them.
 */
export interface ConnectionView {
  state: ConnState;
  serverId: string | null;
  error: AppErrorCode | null;
  /** With SERVER_DELETING: when the server is erased (ms, the server's clock), if it said. */
  deletingAt: number | null;
  /** The snapshot of the server on screen (or the one just left, while it failed). */
  welcome: RendererWelcome | null;
}

export type ConnectionAction =
  | { type: 'state'; event: ConnectionStateEvent }
  | { type: 'joined'; welcome: RendererWelcome }
  /** The screen left its server (the Home screen); a call there goes on in the background. */
  | { type: 'left' }
  /** `serverId`: the saved server the event came from (absent: the one on screen). */
  | { type: 'serverEvent'; event: Envelope; serverId?: string };

export const initialConnection: ConnectionView = { state: 'idle', serverId: null, error: null, deletingAt: null, welcome: null };

/**
 * The last snapshot of each server seen this session, in memory only (never the disk): the rail paints
 * it at once when you switch back, while the real connection refreshes behind it. Cleared when the app closes.
 */
const welcomeCache = new Map<string, RendererWelcome>();
export function cachedWelcome(serverId: string): RendererWelcome | null {
  return welcomeCache.get(serverId) ?? null;
}

function isWelcomeFor(d: unknown, serverId: string): d is RendererWelcome {
  return typeof d === 'object' && d !== null && (d as { serverId?: unknown }).serverId === serverId;
}

/** Pure reducer behind the connection store (spec §11.2). */
export function connectionReducer(s: ConnectionView, a: ConnectionAction): ConnectionView {
  switch (a.type) {
    case 'joined':
      return { state: 'connected', serverId: a.welcome.serverId, error: null, deletingAt: null, welcome: a.welcome };
    case 'left':
      return initialConnection;
    case 'state': {
      // The call's connection in the background is not the screen's (chamada-continua §2).
      if (a.event.background) return s;
      const { state, serverId } = a.event;
      const sameServer = serverId === null || serverId === s.welcome?.serverId;
      return {
        state,
        serverId,
        error: state === 'failed' ? (a.event.error ?? 'CONNECTION_LOST') : null,
        deletingAt: state === 'failed' ? (a.event.deletingAt ?? null) : null,
        // Leaving (idle) or another server's events drop the old snapshot; a failure keeps it on screen.
        welcome: state === 'idle' || !sameServer ? null : s.welcome,
      };
    }
    case 'serverEvent':
      // After a reconnect the new welcome replaces the whole state (spec §13).
      if (a.serverId !== undefined && a.serverId !== s.welcome?.serverId) return s;
      if (a.event.t === 'welcome' && s.welcome !== null && isWelcomeFor(a.event.d, s.welcome.serverId)) {
        return { ...s, welcome: a.event.d };
      }
      return s; // unknown events are ignored (spec §5.1)
  }
}

interface ConnectionStore extends ConnectionView {
  dispatch(action: ConnectionAction): void;
}

export const useConnectionStore = create<ConnectionStore>()((set) => ({
  ...initialConnection,
  dispatch: (action) => {
    // Remember every server's latest snapshot (in memory) so a switch back paints instantly.
    if (action.type === 'joined') welcomeCache.set(action.welcome.serverId, action.welcome);
    set((s) => connectionReducer(s, action));
  },
}));
