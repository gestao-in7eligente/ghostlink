// Main-process bootstrap (contract §5). Everything testable lives in the modules it
// wires together; this file is the thin glue that needs a real Electron.
import { BrowserWindow, Menu, Notification, app, clipboard, desktopCapturer, dialog, net, safeStorage, screen, session, shell } from 'electron';
import { mkdtempSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME, DEFAULT_PORT } from '@ghostlink/shared';
import { IPC_EVENTS, type Locale, type Platform } from '../shared/ipcTypes.js';
import { APP_ORIGIN, registerAppProtocol, registerAppSchemePrivileges } from './appProtocol.js';
import { createAvatars } from './avatars/index.js';
import { ClientController } from './controller.js';
import { GHOSTKEY_EXTENSION, IdentityBackup } from './backup.js';
import { DeepLinks, extractDeepLink, registerProtocolClient } from './deeplink.js';
import { DrawOverlay, keepsOutOfCapture } from './drawOverlay.js';
import { openExternalWithConfirm } from './externalLinks.js';
import { HostFirewall, firewallPrograms } from './hostFirewall.js';
import { HostManager } from './hostManager.js';
import { forkServer, hostedServerLogging } from './hostProcess.js';
import { HostTray, ghostImage, shouldHideOnClose } from './hostTray.js';
import { IdentityStore } from './identity.js';
import { registerIpc } from './ipc.js';
import { FileLog, consoleMirror, guardStdio, installCrashHandlers, mainLog, safeWrite, setMainLog } from './log.js';
import { ChatNotifier } from './notifications.js';
import { installRendererPinning, setRendererPin } from './pinning.js';
import { PushToTalk, type PttHookModule } from './ptt.js';
import { railwayImage } from './railway/image.js';
import { RailwayProvisioner } from './railway/provisioner.js';
import { ServerUpdates } from './railway/serverUpdates.js';
import { RailwayStore } from './railway/store.js';
import { ReleaseNotes } from './releaseNotes.js';
import { RailwayTokenStore } from './railway/token.js';
import { SavedServersStore } from './savedServers.js';
import { ScreenPicker } from './screenPicker.js';
import { installSecurity, originOf } from './security.js';
import { SettingsStore } from './settings.js';
import { runSmoke } from './smoke.js';
import { UpdateSplash } from './updateSplash.js';
import { Updater, createUpdaterBackend, type StartupOutcome } from './updater.js';
import { createReleaseFileFetcher } from './updaterSignature.js';
import { loadWin32WindowApi } from './win32Window.js';
import { applicationMenuTemplate, mainWindowOptions } from './window.js';

const smoke = process.env.GHOSTLINK_SMOKE === '1';
// 0. Before anything can fail: a closed console pipe is never fatal, and uncaught errors are
//    logged instead of showing Electron's modal dialog (smoke mode: they fail the run).
guardStdio();
installCrashHandlers({ log: mainLog, smoke, exit: (code) => app.exit(code) });
// Dev only: electron-vite serves the renderer and passes its URL.
const devRendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const appOrigin = (devRendererUrl && originOf(devRendererUrl)) || APP_ORIGIN;
// Dev/test hook (never honoured when packaged): Host mode binds here instead of 0.0.0.0,
// so automated runs do not trigger the Windows firewall prompt.
const hostBind = app.isPackaged ? undefined : process.env.GHOSTLINK_HOST_BIND || undefined;
/** ghostlink:// links (spec §12), created with the single-instance lock. */
let deepLinks: DeepLinks | null = null;
/** The update splash while the app opens ("Atualizar ao abrir"), until the main window shows. */
let openingSplash: UpdateSplash | null = null;

// 1. Test hook (never honoured when packaged): one profile per instance.
if (!app.isPackaged && process.env.GHOSTLINK_USER_DATA) {
  app.setPath('userData', resolve(process.env.GHOSTLINK_USER_DATA));
}
// 1b. <userData>/logs/main.log; the console only mirrors it in development.
setMainLog(new FileLog({ dir: join(app.getPath('userData'), 'logs'), mirror: app.isPackaged ? null : consoleMirror }));
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
  // spec §12: ghostlink:// links from argv (Windows) and open-url (macOS); the page confirms them.
  const links = new DeepLinks({
    send: (invite) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_EVENTS.deepLink, invite);
    },
    log: (message) => mainLog.warn(message),
  });
  deepLinks = links;
  links.handle(extractDeepLink(process.argv));
  app.on('open-url', (event, url) => {
    event.preventDefault();
    links.handle(url);
  });
  app.on('second-instance', (_event, argv) => {
    links.handle(extractDeepLink(argv));
    if (!mainWindow) openingSplash?.focus(); // still checking for updates: the link waits in DeepLinks
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show(); // it may be hidden in the tray while hosting
    mainWindow?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  mainLog.info(`${APP_NAME} ${app.getVersion()} starting (${process.platform}, ${app.isPackaged ? 'packaged' : 'development'}${smoke ? ', smoke' : ''})`);
  // 5. Everything that needs a ready app.
  app
    .whenReady()
    .then(async () => {
      mainWindow = await start();
    })
    .catch((e: unknown) => {
      mainLog.error('GhostLink failed to start:', e);
      app.exit(1);
    });
}

/** The main window, or null when the app is about to quit (an update installs, or the splash was closed). */
async function start(): Promise<BrowserWindow | null> {
  const userData = app.getPath('userData');
  // Profile photos (v0.2.2): served at app://ghostlink/_avatar/<hash>, also to the dev server's page.
  const avatars = createAvatars({ userDataDir: userData, warn: (message) => mainLog.warn(message) });
  registerAppProtocol(fileURLToPath(new URL('../renderer/', import.meta.url)), { avatar: avatars.route });
  if (!smoke) registerProtocolClient(app, { argv: process.argv, execPath: process.execPath, env: process.env });
  installSecurity({ appOrigin });
  installRendererPinning(session.defaultSession);

  const identity = IdentityStore.load(userData, safeStorage);
  const settings = SettingsStore.load(userData, app.getLocale());
  const servers = SavedServersStore.load(userData);
  // Windows shows toasts (and routes their clicks) only for a known AppUserModelID. Set before the
  // first window (the update splash), so it shares the taskbar button with the main window.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  // The update state reaches the page once the main window exists (the renderer also asks for it on load).
  let target: BrowserWindow | null = null;
  const send = (channel: string, payload: unknown) => {
    if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
  };
  // The Updates page's "O que muda": a found version's notes come from its GitHub release.
  const releaseNotes = new ReleaseNotes({ fetch: (url, init) => net.fetch(url, init), log: (message) => mainLog.warn(message) });
  // Spec §15: Windows installs only, never in development or smoke mode; the setting can turn it off.
  const updater = Updater.load({
    backend: createUpdaterBackend({ packaged: app.isPackaged, smoke, platform: process.platform, resourcesPath: process.resourcesPath }),
    userDataDir: userData,
    currentVersion: app.getVersion(),
    fetchReleaseFile: createReleaseFileFetcher((url, init) => net.fetch(url, init)),
    emit: (state) => {
      releaseNotes.follow(state); // before the page hears of the version, so its notes are already on the way
      send(IPC_EVENTS.updates, state);
    },
  });
  // "Atualizar ao abrir": the first check runs behind the splash, before anything else exists.
  const opening = await checkForUpdatesOnOpen(updater, settings.get().locale);
  if (opening.outcome === 'installing' || opening.splash?.closedByUser) return null;

  const window = createMainWindow();
  target = window;
  if (opening.splash) closeSplashWhenShown(opening.splash, window);
  const controller = new ClientController({
    identity,
    settings,
    servers,
    setRendererPin,
    emitConnectionState: (event) => send(IPC_EVENTS.connectionState, event),
    emitServerEvent: (event) => send(IPC_EVENTS.server, event),
    clientName: `ghostlink/${app.getVersion()} (${process.platform})`,
    onSession: (active) => avatars.onSession(active),
  });
  const host = startHostMode(window, controller, servers, settings, send);
  const notifier = new ChatNotifier({
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    window: () => (window.isDestroyed() ? null : window),
    openChannel: (event) => send(IPC_EVENTS.openChannel, event),
  });
  // Global push-to-talk: the native hook is imported only once the user turns it on (spec §8.4).
  const ptt = new PushToTalk({
    platform: process.platform,
    load: async () => {
      const m = (await import('uiohook-napi')) as Partial<PttHookModule> & { default?: PttHookModule };
      return m.uIOhook && m.UiohookKey ? (m as PttHookModule) : m.default!;
    },
    emit: (pressed) => send(IPC_EVENTS.ptt, { pressed }),
    warn: (message) => mainLog.warn(message),
  });
  app.on('before-quit', () => void ptt.dispose());
  // "Criar um servidor" on Railway (v0.2): the token stays encrypted here; only main talks to Railway.
  const railwayStore = RailwayStore.load(userData); // one copy in memory, shared by both below
  const serverImage = railwayImage({ version: app.getVersion(), packaged: app.isPackaged, env: process.env });
  const railway = new RailwayProvisioner({
    userDataDir: userData,
    safeStorage,
    store: railwayStore,
    fetch: (url, init) => net.fetch(url, init),
    image: serverImage,
    probe: (address) => controller.probe(address),
    join: (req) => controller.join(req),
    emit: (progress) => send(IPC_EVENTS.railway, progress),
  });
  // Servers follow the app's version (v0.2.2): the Railway servers this app created get its version.
  const railwayTokens = new RailwayTokenStore(userData, safeStorage);
  const serverUpdates = new ServerUpdates({
    store: railwayStore,
    token: () => railwayTokens.read(),
    fetch: (url, init) => net.fetch(url, init),
    appVersion: app.getVersion(),
    image: serverImage,
    serverKey: (serverKeyId) => identity.serverKey(serverKeyId),
    emit: (update) => send(IPC_EVENTS.serverUpdates, update),
  });
  // Screen sharing (screen sharing spec §3): the renderer's own picker lists the sources, and the
  // capture request gets exactly the chosen one. Never the system picker (no useSystemPicker).
  const screenPicker = new ScreenPicker({
    getSources: (opts) => desktopCapturer.getSources(opts),
    now: () => Date.now(),
    appOrigin,
    ownMediaSourceId: () => (window.isDestroyed() ? null : window.getMediaSourceId()),
  });
  // The pencil over the shared monitor (pencil spec §4): it opens over the screen main handed over,
  // or follows the shared window (Windows: koffi is imported with the first one).
  const drawOverlay = new DrawOverlay({
    url: `${APP_ORIGIN}/drawOverlay.html`,
    preload: fileURLToPath(new URL('../preload/drawOverlay.cjs', import.meta.url)),
    packaged: app.isPackaged,
    screenSources: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
    displays: () => screen.getAllDisplays(),
    createWindow: (options) => new BrowserWindow(options),
    excludedFromCapture: keepsOutOfCapture(process.platform, release()),
    windowApi: () => loadWin32WindowApi({ platform: process.platform }),
    screenToDip: (rect) => screen.screenToDipRect(null, rect),
    log: (message) => mainLog.warn(message),
  });
  // A reload, a crash or the window closing ends the share, and the overlay with it.
  window.on('closed', () => drawOverlay.close());
  window.webContents.on('render-process-gone', () => drawOverlay.close());
  window.webContents.on('did-start-loading', () => drawOverlay.close());
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const answer = (streams: Parameters<typeof callback>[0]) => {
      drawOverlay.granted(streams.video && 'id' in streams.video ? streams.video.id : null);
      callback(streams);
    };
    screenPicker.handleRequest(request, answer).catch((e: unknown) => mainLog.error('[screen] the capture answer failed:', e));
  });
  registerIpc({
    appOrigin,
    identity,
    settings,
    controller,
    notifications: notifier,
    shell: {
      openExternal: (url) => openExternalWithConfirm(url, {
        locale: () => settings.get().locale,
        confirm: async (d) => (await dialog.showMessageBox(window, {
          type: 'question',
          title: d.title,
          message: d.message,
          detail: d.detail,
          buttons: d.buttons,
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })).response,
        open: (url) => shell.openExternal(url),
      }),
      copyText: (text) => clipboard.writeText(text),
    },
    updates: updater,
    releaseNotes,
    ptt,
    appInfo: () => ({ version: app.getVersion(), platform: process.platform as Platform, locale: app.getLocale() }),
    host: { manager: host, copyText: (text) => clipboard.writeText(text), firewall: hostFirewall(host) },
    backup: identityBackup(window, identity, controller),
    deepLinks: deepLinks ?? undefined,
    railway,
    profile: avatars.profile,
    screen: screenPicker,
    draw: drawOverlay,
    serverUpdates,
  });
  updater.start(); // the 6 h checks; the first one already ran behind the splash when it showed
  // After the update check at startup (the app runs its newest version by now), then every 30 min.
  // Installed apps only: a development build must not redeploy real servers on its own (opt in with
  // GHOSTLINK_SERVER_UPDATES=1); "Atualizar agora" works in both.
  if (!smoke && (app.isPackaged || process.env.GHOSTLINK_SERVER_UPDATES === '1')) serverUpdates.start();
  app.on('before-quit', () => {
    updater.dispose();
    serverUpdates.dispose();
    void controller.disconnect();
  });

  // 6. Smoke mode (spec §14): listeners first, then the page load.
  if (smoke) startSmoke(window);
  void window.loadURL(devRendererUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}

/**
 * "Atualizar ao abrir": the splash shows the steps of Updater.checkAtStartup. It opens on the first
 * step, so it never appears when no check runs (turned off; development, smoke mode and anything but
 * the installed Windows app are unsupported). Closing it (Alt+F4) quits the app, as for any last window.
 */
async function checkForUpdatesOnOpen(updater: Updater, locale: Locale): Promise<{ outcome: StartupOutcome; splash: UpdateSplash | null }> {
  const skip = new AbortController();
  const shown: { splash: UpdateSplash | null } = { splash: null };
  const outcome = await updater.checkAtStartup({
    signal: skip.signal,
    onStep: (step) => {
      shown.splash ??= openSplash(locale, () => skip.abort());
      shown.splash.show(step);
    },
  });
  return { outcome, splash: shown.splash };
}

function openSplash(locale: Locale, stopWaiting: () => void): UpdateSplash {
  openingSplash = new UpdateSplash({
    url: `${APP_ORIGIN}/splash.html`,
    preload: fileURLToPath(new URL('../preload/splash.cjs', import.meta.url)),
    packaged: app.isPackaged,
    icon: ghostImage(32),
    locale,
    onSkip: stopWaiting,
    onClosedByUser: stopWaiting,
    log: (message) => mainLog.warn(message),
  });
  return openingSplash;
}

/** The splash stays until the main window appears (at most 10 s more), as Discord's does. */
function closeSplashWhenShown(splash: UpdateSplash, window: BrowserWindow): void {
  const close = () => {
    clearTimeout(fallback);
    splash.close();
    if (openingSplash === splash) openingSplash = null;
  };
  const fallback = setTimeout(close, 10_000);
  window.once('show', close);
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
    // The Host panel keeps its own line buffer (opts.onLog); every line also goes to the main log file.
    fork: (opts) => {
      const toFile = hostedServerLogging(mainLog);
      return forkServer({
        ...opts,
        onLog: (text, stream) => {
          opts.onLog?.(text, stream);
          toFile.onLog?.(text, stream);
        },
        onError: toFile.onError,
      });
    },
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

/** spec §3.4: .ghostkey export/import through the native dialogs; the seed stays in this process. */
function identityBackup(window: BrowserWindow, identity: IdentityStore, controller: ClientController): IdentityBackup {
  const filters = [{ name: 'GhostLink', extensions: [GHOSTKEY_EXTENSION] }];
  return new IdentityBackup({
    identity,
    disconnect: () => controller.disconnect(),
    dialogs: {
      save: async (defaultName) => {
        const r = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath('documents'), defaultName), filters });
        return r.canceled || !r.filePath ? null : r.filePath;
      },
      open: async () => {
        const r = await dialog.showOpenDialog(window, { properties: ['openFile'], filters });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
      },
    },
  });
}

/** spec §8.5: the firewall rules cover GhostLink.exe (the hosted server runs in it) and livekit-server.exe. */
function hostFirewall(host: HostManager): HostFirewall {
  const livekitCandidates = app.isPackaged
    ? [join(process.resourcesPath, 'livekit', 'livekit-server.exe')]
    : [fileURLToPath(new URL('../../resources/livekit/win-x64/livekit-server.exe', import.meta.url))];
  return new HostFirewall({
    programs: () => firewallPrograms({ execPath: process.execPath, livekitCandidates }),
    ports: () => ({ tcpPorts: [host.status().config?.port ?? DEFAULT_PORT, 7881], udpPorts: [7882] }),
  });
}

function createMainWindow(): BrowserWindow {
  // Packaged: no reload or DevTools shortcuts (Windows: no menu at all; macOS: app and Edit only).
  const menu = applicationMenuTemplate({ packaged: app.isPackaged, platform: process.platform });
  if (menu !== undefined) Menu.setApplicationMenu(menu === null ? null : Menu.buildFromTemplate(menu));
  const window = new BrowserWindow(
    mainWindowOptions({
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      packaged: app.isPackaged,
      platform: process.platform,
      icon: ghostImage(32),
    }),
  );
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
    forkServer: () =>
      forkServer({ dataDir: mkdtempSync(join(app.getPath('temp'), 'ghostlink-smoke-')), port: 0, ...hostedServerLogging(mainLog) }),
    exit: (code) => app.exit(code),
    // `npm run smoke` reads "smoke: OK" from stdout; in development the log mirror prints it.
    log: (message) => {
      mainLog.info(message);
      if (app.isPackaged) safeWrite(process.stdout, `${message}\n`);
    },
  });
}
