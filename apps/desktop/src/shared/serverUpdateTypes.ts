// Servers follow the app's version (spec 2026-10-01-servidores-acompanham-o-app-design.md):
// the owner's app keeps the Railway servers it created on its own version (§3) and tells the
// owner when the connected server is behind (§5). Shared by main, preload and renderer.

/**
 * Where the update of one managed server stands:
 * - `unknown`: not checked yet this session (or /health did not answer a release version);
 * - `current`: it runs the app's version (or a newer one);
 * - `waiting`: older, and someone is in a call (or that cannot be known): it updates when the call
 *   empties, or 24 h after it was first seen behind;
 * - `updating`: the new image is being deployed;
 * - `failed`: the last update did not finish; the next check tries again;
 * - `railwayDisconnected`: older, but there is no Railway token (or Railway refused it);
 * - `addingAgent`: a company agent (`agent`) is being provisioned onto the server (independent of its version).
 */
export type ServerUpdateState = 'unknown' | 'current' | 'waiting' | 'updating' | 'failed' | 'railwayDisconnected' | 'addingAgent';

export interface ManagedServerUpdate {
  serverKeyId: string;
  /** What the server's /health answered last; null before the first answer. */
  version: string | null;
  /** The app's version: the only one the app ever updates the server to. */
  target: string;
  state: ServerUpdateState;
  /** With state `addingAgent`, the key of the agent being provisioned (e.g. "aurora"); absent otherwise. */
  agent?: string;
}

/** window.ghostlink.serverUpdates. */
export interface ServerUpdatesApi {
  /** The update of a Railway server this app created; null for any other server. */
  state(serverKeyId: string): Promise<ManagedServerUpdate | null>;
  /**
   * Updates it now, without waiting for the call to empty (the page confirms first). Resolves
   * once the update started (state `updating`); its end arrives through onState.
   */
  updateNow(serverKeyId: string): Promise<ManagedServerUpdate>;
  onState(cb: (update: ManagedServerUpdate) => void): () => void;
}
