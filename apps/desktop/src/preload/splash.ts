// Sandboxed preload of the update splash (main/updateSplash.ts): it receives the view to show and
// sends "Open without updating", nothing else. Like the main preload, it imports only `electron`
// and a module of its own, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer } from 'electron';
import { SPLASH_CHANNELS, type SplashApi, type SplashView } from '../shared/splash.js';

// Listening from the start keeps a view that arrives before the page subscribes.
let latest: SplashView | null = null;
let listener: ((view: SplashView) => void) | null = null;
ipcRenderer.on(SPLASH_CHANNELS.view, (_event, view: SplashView) => {
  latest = view;
  listener?.(view);
});

const api: SplashApi = {
  onView: (cb) => {
    listener = cb;
    if (latest !== null) cb(latest);
  },
  skip: () => ipcRenderer.send(SPLASH_CHANNELS.skip),
};

contextBridge.exposeInMainWorld('ghostlinkSplash', api);
