// Main-process bootstrap (contract §5). Everything testable lives in the modules it
// wires together; this file is the thin glue that needs a real Electron.
import { BrowserWindow, app, safeStorage, session } from 'electron';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@ghostlink/shared';
import { IPC_EVENTS, type Platform } from '../shared/ipcTypes.js';
import { APP_ORIGIN, registerAppProtocol, registerAppSchemePrivileges } from './appProtocol.js';
import { ClientController } from './controller.js';
import { forkServer } from './hostProcess.js';
import { IdentityStore } from './identity.js';
import { registerIpc } from './ipc.js';
import { installRendererPinning, setRendererPin } from './pinning.js';
import { PushToTalk, type PttHookModule } from './ptt.js';
import { SavedServersStore } from './savedServers.js';
import { installSecurity, originOf } from './security.js';
import { SettingsStore } from './settings.js';
import { runSmoke } from './smoke.js';

const smoke = process.env.GHOSTLINK_SMOKE === '1';
// Dev only: electron-vite serves the renderer and passes its URL.
const devRendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const appOrigin = (devRendererUrl && originOf(devRendererUrl)) || APP_ORIGIN;

// 1. Test hook (never honoured when packaged): one profile per instance.
if (!app.isPackaged && process.env.GHOSTLINK_USER_DATA) {
  app.setPath('userData', resolve(process.env.GHOSTLINK_USER_DATA));
}
// 2. One single list of disabled features. Without it Chromium caches certificate
//    decisions — rejections included — for 30 min, breaking pin changes (spec §4).
app.commandLine.appendSwitch('disable-features', 'CacheCertVerification');
// 3. Must happen before ready.
registerAppSchemePrivileges();
// 4. The lock is per userData directory, hence after step 1.
if (!app.requestSingleInstanceLock()) {
  app.exit(smoke ? 1 : 0);
} else {
  let mainWindow: BrowserWindow | null = null;
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  // 5. Everything that needs a ready app.
  app
    .whenReady()
    .then(() => {
      mainWindow = start();
    })
    .catch((e: unknown) => {
      console.error('GhostLink failed to start:', e);
      app.exit(1);
    });
}

function start(): BrowserWindow {
  registerAppProtocol(fileURLToPath(new URL('../renderer/', import.meta.url)));
  installSecurity({ appOrigin });
  installRendererPinning(session.defaultSession);

  const userData = app.getPath('userData');
  const identity = IdentityStore.load(userData, safeStorage);
  const settings = SettingsStore.load(userData, app.getLocale());
  const servers = SavedServersStore.load(userData);

  const window = createMainWindow();
  const send = (channel: string, payload: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const controller = new ClientController({
    identity,
    settings,
    servers,
    setRendererPin,
    emitConnectionState: (event) => send(IPC_EVENTS.connectionState, event),
    emitServerEvent: (event) => send(IPC_EVENTS.server, event),
    clientName: `ghostlink/${app.getVersion()} (${process.platform})`,
  });
  // Global push-to-talk: the native hook is imported only once the user turns it on (spec §8.4).
  const ptt = new PushToTalk({
    platform: process.platform,
    load: async () => {
      const m = (await import('uiohook-napi')) as Partial<PttHookModule> & { default?: PttHookModule };
      return m.uIOhook && m.UiohookKey ? (m as PttHookModule) : m.default!;
    },
    emit: (pressed) => send(IPC_EVENTS.ptt, { pressed }),
    warn: (message) => console.warn(message),
  });
  app.on('before-quit', () => void ptt.dispose());
  registerIpc({
    appOrigin,
    identity,
    settings,
    controller,
    ptt,
    appInfo: () => ({ version: app.getVersion(), platform: process.platform as Platform, locale: app.getLocale() }),
  });
  app.on('before-quit', () => void controller.disconnect());

  // 6. Smoke mode (spec §14): listeners first, then the page load.
  if (smoke) startSmoke(window);
  void window.loadURL(devRendererUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: '#0b0d10',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Remote voice plays without a click first (spec §8.4); room.startAudio() covers the rest.
      autoplayPolicy: 'no-user-gesture-required',
      // The microphone gate runs on renderer timers: they must keep their pace while a game has focus.
      backgroundThrottling: false,
    },
  });
  if (!smoke) window.once('ready-to-show', () => window.show());
  return window;
}

function startSmoke(window: BrowserWindow): void {
  const loaded = new Promise<void>((resolveLoad, rejectLoad) => {
    window.webContents.once('did-finish-load', () => resolveLoad());
    window.webContents.once('did-fail-load', (_event, code, description) => rejectLoad(new Error(`did-fail-load ${code} ${description}`)));
  });
  void runSmoke({
    waitForLoad: () => loaded,
    rendererReady: async () =>
      (await window.webContents.executeJavaScript(
        "document.documentElement.dataset.ready === '1' && typeof window.ghostlink?.app?.info === 'function'",
      )) === true,
    forkServer: () => forkServer({ dataDir: mkdtempSync(join(app.getPath('temp'), 'ghostlink-smoke-')), port: 0 }),
    exit: (code) => app.exit(code),
    log: (message) => console.log(message),
  });
}
