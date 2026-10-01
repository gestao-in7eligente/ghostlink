// The renderer's copy of what main knows about the update of the connected server
// (main/railway/serverUpdates.ts is the source of truth), and the bands closed this session.
import { create } from 'zustand';
import type { GhostlinkApi } from '../../../shared/ipcTypes.js';
import type { ManagedServerUpdate } from '../../../shared/serverUpdateTypes.js';

interface ServerUpdateStore {
  /** app.info().version; null until main answered. */
  appVersion: string | null;
  /** Per serverKeyId: main's answer (null: not a server this app created on Railway). */
  managed: Readonly<Record<string, ManagedServerUpdate | null>>;
  /** noticeKey() of the bands the owner closed. */
  dismissed: readonly string[];
  dismiss(key: string): void;
}

export const useServerUpdateStore = create<ServerUpdateStore>()((set) => ({
  appVersion: null,
  managed: {},
  dismissed: [],
  dismiss: (key) => set((s) => (s.dismissed.includes(key) ? s : { dismissed: [...s.dismissed, key] })),
}));

/** main's answer for that server; undefined until it arrived. */
export function managedFor(managed: Readonly<Record<string, ManagedServerUpdate | null>>, serverKeyId: string): ManagedServerUpdate | null | undefined {
  return Object.hasOwn(managed, serverKeyId) ? managed[serverKeyId] : undefined;
}

/** Keeps what main said about one server. */
export function keepServerUpdate(update: ManagedServerUpdate): void {
  keep(update.serverKeyId, update);
}

function keep(serverKeyId: string, update: ManagedServerUpdate | null): void {
  useServerUpdateStore.setState((s) => ({ managed: { ...s.managed, [serverKeyId]: update } }));
}

/** Loads the app version and the server's state, then follows main's events. Returns the unsubscribe function. */
export function syncServerUpdate(api: Pick<GhostlinkApi, 'app' | 'serverUpdates'>, serverKeyId: string): () => void {
  let alive = true;
  const off = api.serverUpdates.onState(keepServerUpdate);
  if (useServerUpdateStore.getState().appVersion === null) {
    api.app.info().then(
      (info) => alive && useServerUpdateStore.setState({ appVersion: info.version }),
      () => {}, // no version: no band
    );
  }
  api.serverUpdates.state(serverKeyId).then(
    (update) => alive && keep(serverKeyId, update),
    () => {}, // unknown: no band rather than a wrong one
  );
  return () => {
    alive = false;
    off();
  };
}
