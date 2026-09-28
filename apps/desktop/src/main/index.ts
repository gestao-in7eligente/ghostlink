// Main-process bootstrap (contract §5). Everything testable lives in the modules it
// wires together; this file is the thin glue that needs a real Electron.
import { BrowserWindow, app, clipboard, safeStorage, session } from 'electron';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@ghostlink/shared';
import { IPC_EVENTS, type Platform } from '../shared/ipcTypes.js';
import { APP_ORIGIN, registerAppProtocol, registerAppSchemePrivileges } from './appProtocol.js';
import { ClientController } from './controller.js';
import { HostManager } from './hostManager.js';
import { forkServer } from './hostProcess.js';
import { HostTray, shouldHideOnClose } from './hostTray.js';
import { IdentityStore } from './identity.js';
import { registerIpc } from './ipc.js';
import { installRendererPinning, setRendererPin } from './pinning.js';
import { SavedServersStore } from './savedServers.js';
import { installSecurity, originOf } from './security.js';
import { SettingsStore } from './settings.js';
import { runSmoke } from './smoke.js';

const smoke = process.env.GHOSTLINK_SMOKE === '1';
// Dev only: electron-vite serves the renderer and passes its URL.
const devRendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const appOrigin = (devRendererUrl && originOf(devRendererUrl)) || APP_ORIGIN;
// Dev/test hook (never honoured when packaged): Host mode binds here instead of 0.0.0.0,
// so automated runs do not trigger the Windows firewall prompt.
const hostBind = app.isPackaged ? undefined : process.env.GHOSTLINK_HOST_BIND || undefined;

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
    mainWindow?.show(); // it may be hidden in the tray while hosting
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
  const host = startHostMode(window, controller, servers, settings, send);
  registerIpc({
    appOrigin,
    identity,
    settings,
    controller,
    appInfo: () => ({ version: app.getVersion(), platform: process.platform as Platform, locale: app.getLocale() }),
    host: { manager: host, copyText: (text) => clipboard.writeText(text) },
  });
  app.on('before-quit', () => void controller.disconnect());

  // 6. Smoke mode (spec §14): listeners first, then the page load.
  if (smoke) startSmoke(window);
  void window.loadURL(devRendererUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

/**
 * Host mode (spec §9): the hosted server's manager, the tray, and the window/quit
 * rules — closing the window while hosting hides it; quitting stops the server first.
 */
function startHostMode(
  window: BrowserWindow,
  controller: ClientController,
  servers: SavedServersStore,
  settings: SettingsStore,
  send: (channel: string, payload: unknown) => void,
): HostManager {
  const showWindow = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const tray = new HostTray({ locale: () => settings.get().locale, onOpen: showWindow, onStopAndQuit: () => app.quit() });
  const host = new HostManager({
    userDataDir: app.getPath('userData'),
    fork: forkServer,
    join: (req) => controller.join(req),
    leave: async (serverKeyId) => {
      if (servers.findByServerKeyId(serverKeyId)?.id === controller.currentServerId) await controller.disconnect();
    },
    nickname: () => settings.get().nickname,
    emit: (status) => {
      send(IPC_EVENTS.host, status);
      tray.update(status);
    },
    bindHost: hostBind,
  });

  let quitting = false;
  let stoppedForQuit = false;
  window.on('close', (event) => {
    if (!shouldHideOnClose({ hosting: host.isActive(), quitting })) return;
    event.preventDefault();
    window.hide();
    if (!host.trayNoticeShown()) {
      tray.notifyKeptRunning();
      host.markTrayNoticeShown();
    }
  });
  app.on('activate', showWindow); // macOS: the Dock icon brings the hidden window back
  app.on('before-quit', (event) => {
    quitting = true;
    if (stoppedForQuit || !host.isActive()) return;
    // "Sair" stops the server and LiveKit (spec §9). One attempt only: a failure never blocks quitting.
    event.preventDefault();
    stoppedForQuit = true;
    void host
      .stopForQuit()
      .catch((e: unknown) => console.error('[host] could not stop the hosted server:', e))
      .finally(() => {
        tray.destroy();
        app.quit();
      });
  });
  return host;
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
