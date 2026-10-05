import type { GhostlinkApi } from '../shared/ipcTypes.js';

declare global {
  interface Window {
    /** Exposed by the preload through contextBridge (contract §5). */
    readonly ghostlink: GhostlinkApi;
  }
}
