// The open server's deletion (spec §3): the welcome's `serverDelete.deletingAt`, then the
// `server.deleting` / `server.restored` events (DeletionBanner.tsx's useServerDeleteSync feeds it).
// Only the owner stays connected to see it.
import { create } from 'zustand';
import { serverDeletingEventSchemaClient, type Envelope } from '@ghostlink/shared';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { welcomeDeletingAt } from './serverDeleteModel.js';

export interface DeletionView {
  /** The saved server these values belong to. */
  serverId: string | null;
  /** The erase deadline (ms, the server's clock), or null when the server is not being deleted. */
  deletingAt: number | null;
}

export type DeletionAction = { type: 'welcome'; welcome: RendererWelcome } | { type: 'event'; serverId: string; event: Envelope } | { type: 'restored'; serverId: string };

export const initialDeletion: DeletionView = { serverId: null, deletingAt: null };

/** Pure reducer behind the store; events of another server are ignored. */
export function deletionReducer(s: DeletionView, a: DeletionAction): DeletionView {
  switch (a.type) {
    case 'welcome':
      return { serverId: a.welcome.serverId, deletingAt: welcomeDeletingAt(a.welcome) };
    case 'restored':
      return a.serverId === s.serverId ? { ...s, deletingAt: null } : s;
    case 'event': {
      if (a.serverId !== s.serverId) return s;
      if (a.event.t === 'server.restored') return { ...s, deletingAt: null };
      if (a.event.t !== 'server.deleting') return s;
      const parsed = serverDeletingEventSchemaClient.safeParse(a.event.d);
      return parsed.success ? { ...s, deletingAt: parsed.data.at } : s;
    }
  }
}

interface DeletionStore extends DeletionView {
  dispatch(action: DeletionAction): void;
}

export const useDeletionStore = create<DeletionStore>()((set) => ({
  ...initialDeletion,
  dispatch: (action) => set((s) => deletionReducer(s, action)),
}));
