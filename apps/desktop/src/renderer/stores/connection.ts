import { create } from 'zustand';
import type { Envelope } from '@ghostlink/shared';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { ConnState, ConnectionStateEvent, RendererWelcome } from '../../shared/ipcTypes.js';

export interface ConnectionView {
  state: ConnState;
  serverId: string | null;
  error: AppErrorCode | null;
  /** The snapshot of the server we are (or were just) connected to. */
  welcome: RendererWelcome | null;
}

export type ConnectionAction =
  | { type: 'state'; event: ConnectionStateEvent }
  | { type: 'joined'; welcome: RendererWelcome }
  | { type: 'serverEvent'; event: Envelope };

export const initialConnection: ConnectionView = { state: 'idle', serverId: null, error: null, welcome: null };

function isWelcomeFor(d: unknown, serverId: string): d is RendererWelcome {
  return typeof d === 'object' && d !== null && (d as { serverId?: unknown }).serverId === serverId;
}

/** Pure reducer behind the connection store (spec §11.2). */
export function connectionReducer(s: ConnectionView, a: ConnectionAction): ConnectionView {
  switch (a.type) {
    case 'joined':
      return { state: 'connected', serverId: a.welcome.serverId, error: null, welcome: a.welcome };
    case 'state': {
      const { state, serverId } = a.event;
      const sameServer = serverId === null || serverId === s.welcome?.serverId;
      return {
        state,
        serverId,
        error: state === 'failed' ? (a.event.error ?? 'CONNECTION_LOST') : null,
        // Leaving (idle) or another server's events drop the old snapshot; a failure keeps it on screen.
        welcome: state === 'idle' || !sameServer ? null : s.welcome,
      };
    }
    case 'serverEvent':
      // After a reconnect the new welcome replaces the whole state (spec §13).
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
  dispatch: (action) => set((s) => connectionReducer(s, action)),
}));
