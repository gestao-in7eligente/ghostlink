// Auto-update state shared by main (updater.ts), the preload and the renderer (spec §15).
// Type-only at run time, like ipcTypes.ts.

/**
 * - `unsupported`: the updater never runs here (development build, smoke test, or not the
 *   installed Windows app). v0.1 updates Windows only.
 * - `disabled`: the person turned automatic checks off.
 * - `idle` → `checking` → `downloading` → `downloaded` ("Restart to update").
 * - `rejected`: the download failed the Ed25519 release-signature check and was deleted.
 */
export type UpdateStatus = 'unsupported' | 'disabled' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'rejected';

export interface UpdateState {
  status: UpdateStatus;
  /** The setting: check at startup and every 6 h (on by default). */
  autoCheck: boolean;
  currentVersion: string;
  /** The new version while downloading, once downloaded, or when rejected. */
  version: string | null;
  /** 0–100 while downloading. */
  percent: number | null;
  /** When a check last got GitHub's answer (ms since the epoch), this session; null before the first one. */
  lastCheckedAt: number | null;
}

export interface UpdatesApi {
  state(): Promise<UpdateState>;
  setAutoCheck(enabled: boolean): Promise<UpdateState>;
  /**
   * "Procurar atualizações": one check now, resolving with the state once it ended. Skipped while
   * another check runs or an update is downloading or waiting for the restart.
   */
  checkNow(): Promise<UpdateState>;
  /** Quits and runs the downloaded installer; refused unless the status is `downloaded`. */
  restart(): Promise<void>;
  onState(cb: (state: UpdateState) => void): () => void;
}
