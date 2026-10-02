// Main-process bootstrap (contract §5). Everything testable lives in the modules it
// wires together; this file is the thin glue that needs a real Electron.
import { BrowserWindow, Menu, Notification, app, clipboard, desktopCapturer, dialog, ipcMain, net, safeStorage, screen, session, shell } from 'electron';
import { mkdtempSync } from 'node:fs';
import { release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, DEFAULT_PORT } from '@ghostlink/shared';
import { IPC_EVENTS, type Locale, type Platform, type ServerEventMessage } from '../shared/ipcTypes.js';
import { APP_ORIGIN, registerAppProtocol, registerAppSchemePrivileges, type AppRoutes } from './appProtocol.js';
import { createAttachments } from './attachments/index.js';
import { createAvatars } from './avatars/index.js';
import { ClientController } from './controller.js';
import { GHOSTKEY_EXTENSION, IdentityBackup, type IdentityBackupDeps } from './backup.js';
import { DeepLinks, extractDeepLink, registerProtocolClient } from './deeplink.js';
import { DrawOverlay, keepsOutOfCapture } from './drawOverlay.js';
import { openExternalWithConfirm } from './externalLinks.js';
import { HostFirewall, firewallPrograms } from './hostFirewall.js';
import { HostManager } from './hostManager.js';
import { forkServer, hostedServerLogging } from './hostProcess.js';
import { IdentityStore } from './identity.js';
import { registerIpc } from './ipc.js';
import { FileLog, consoleMirror, guardStdio, installCrashHandlers, mainLog, safeWrite, setMainLog } from './log.js';
import { ChatNotifier } from './notifications.js';
import { createDmFileRoute } from './p2p/dmFileRoute.js';
import { FriendsEngine, friendsEnv, watchIdentity } from './p2p/engine.js';
import { installRendererPinning, setRendererPins } from './pinning.js';
import { PushToTalk, type PttHookModule } from './ptt.js';
import { railwayImage } from './railway/image.js';
import { RailwayProvisioner } from './railway/provisioner.js';
import { ServerUpdates } from './railway/serverUpdates.js';
import { RailwayStore } from './railway/store.js';
import { ReleaseNotes } from './releaseNotes.js';
import { RailwayTokenStore } from './railway/token.js';
import { SavedServersStore } from './savedServers.js';
import { ServerDeletions } from './serverDeletions.js';
import { ScreenPicker } from './screenPicker.js';
import { installSecurity, originOf } from './security.js';
import { SettingsStore } from './settings.js';
import { runSmoke } from './smoke.js';
import { ToastStack } from './toasts.js';
import { AppTray, ghostImage, shouldHideOnClose } from './tray.js';
import { UpdateSplash } from './updateSplash.js';
import { Updater, createUpdaterBackend, type StartupOutcome } from './updater.js';
import { createReleaseFileFetcher } from './updaterSignature.js';
import { loadWin32WindowApi } from './win32Window.js';
import { appUserModelId, applicationMenuTemplate, mainWindowOptions } from './window.js';

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
    revealWindow(mainWindow); // the link's page shows, even when the window was in the tray
  });
  app.on('second-instance', (_event, argv) => {
    links.handle(extractDeepLink(argv));
    if (!mainWindow) openingSplash?.focus(); // still checking for updates: the link waits in DeepLinks
    revealWindow(mainWindow); // it may be hidden in the tray
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
  // The server icon goes up over the connection of its server, which the controller (created below) holds.
  const avatars = createAvatars({ userDataDir: userData, warn: (message) => mainLog.warn(message), sessionOf: (id) => controller.sessionOf(id) });
  // Attachments' _file route joins once the window exists (its "Baixar" needs the window's dialog).
  const appRoutes: AppRoutes = { avatar: avatars.route };
  const appRequests = registerAppProtocol(fileURLToPath(new URL('../renderer/', import.meta.url)), appRoutes);
  if (!smoke) registerProtocolClient(app, { argv: process.argv, execPath: process.execPath, env: process.env });
  installSecurity({ appOrigin });
  installRendererPinning(session.defaultSession);

  const identity = IdentityStore.load(userData, safeStorage);
  const settings = SettingsStore.load(userData, app.getLocale());
  const servers = SavedServersStore.load(userData);
  // Windows shows toasts (and routes their clicks) only for a known AppUserModelID. Set before the
  // first window (the update splash), so it shares the taskbar button with the main window.
  // Development and test runs use their own ID: Electron creates a Start-menu "Electron.lnk" for the
  // ID it toasts under, and one sharing the installed app's ID gave its taskbar button Electron's icon.
  if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged));

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
  // Files in server channels (v0.3.3): uploads with progress, app://ghostlink/_file and "Baixar".
  const attachments = createAttachments({
    userDataDir: userData,
    emitProgress: (event) => send(IPC_EVENTS.attachmentProgress, event),
    save: { fetch: appRequests, choosePath: attachmentSavePath(window) },
    warn: (message) => mainLog.warn(message),
  });
  appRoutes.file = attachments.route;
  // Deleting a server (v0.2.4): what the connection learns reaches the sweep created further down.
  let deletions: ServerDeletions | null = null;
  const controller = new ClientController({
    identity,
    settings,
    servers,
    setRendererPins,
    emitConnectionState: (event) => send(IPC_EVENTS.connectionState, event),
    emitServerEvent: (event, serverId) => send(IPC_EVENTS.server, { serverId, event } satisfies ServerEventMessage),
    clientName: `ghostlink/${app.getVersion()} (${process.platform})`,
    onSession: (active) => {
      avatars.onSession(active);
      attachments.onSession(active);
    },
    onDeletion: (update) => deletions?.observe(update),
  });
  // GhostLink's own notification cards (v0.4.2, Windows and Linux): their window opens with the first one.
  const toasts = new ToastStack({
    url: `${APP_ORIGIN}/toast.html`,
    preload: fileURLToPath(new URL('../preload/toast.cjs', import.meta.url)),
    packaged: app.isPackaged,
    platform: process.platform,
    createWindow: (options) => new BrowserWindow(options),
    workArea: () => screen.getPrimaryDisplay().workArea,
    ipc: ipcMain,
    locale: () => settings.get().locale,
    log: (message) => mainLog.warn(message),
  });
  // A hidden cards window would keep the app from quitting once the main window is gone.
  window.on('closed', () => toasts.dispose());
  app.on('before-quit', () => toasts.dispose());
  const notifier = new ChatNotifier({
    platform: process.platform,
    enabled: () => settings.get().desktopNotifications !== false,
    locale: () => settings.get().locale,
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    toasts,
    window: () => (window.isDestroyed() ? null : window),
    openChannel: (event) => send(IPC_EVENTS.openChannel, event),
    // A direct message's click takes the same path: a conversation id is 32 lowercase hex
    // characters, never a channel id (26 base32 characters), so the renderer can tell them apart.
    openConversation: (conv) => send(IPC_EVENTS.openChannel, { channelId: conv }),
    openFriendRequests: () => send(IPC_EVENTS.openFriendRequests, null),
  });
  const { host, tray } = startHostMode(window, controller, servers, settings, send, (text) => void notifier.showNotice(text));
  // Friends over P2P (v0.3): the engine follows the identity; the smoke run has its own self-test on loopback.
  const friends = new FriendsEngine({
    identity,
    settings,
    userDataDir: userData,
    emit: (snapshot) => {
      send(IPC_EVENTS.friends, snapshot);
      notifier.friendsChanged(snapshot); // a new request gets a card
    },
    emitDm: (event) => send(IPC_EVENTS.dm, event),
    notifyDm: (notification) => void notifier.showDm(notification),
    // "Baixar" on a DM file: the same save dialog (and e2e hook) as server attachments.
    chooseSavePath: attachmentSavePath(window),
    log: mainLog,
    ...(smoke ? { network: false } : friendsEnv(process.env, app.isPackaged)),
  });
  // DM files (v0.3.3): app://ghostlink/_dmfile/<hash>, only what a message here carries.
  appRoutes.dmFile = createDmFileRoute((hash) => friends.dmFile(hash));
  // What IPC and the backup do to the identity (create, unlock, import, delete) reaches the engine.
  const watchedIdentity = watchIdentity(identity, () => void friends.sync());
  void friends.sync();
  app.on('before-quit', () => void friends.dispose());
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
  // A deleted server's leftovers (leave/delete spec §3): its Railway project, or hosted/<slug>, after the deadline.
  deletions = new ServerDeletions({
    railway: railwayStore,
    token: () => railwayTokens.read(),
    fetch: (url, init) => net.fetch(url, init),
    host,
    forget: async (serverKeyId) => {
      const saved = servers.findByServerKeyId(serverKeyId);
      if (saved) await controller.remove(saved.id);
    },
  });
  // Screen sharing (screen sharing spec §3): the renderer's own picker lists the sources, and the
  // capture request gets exactly the chosen one. Never the system picker (no useSystemPicker).
  const screenPicker = new ScreenPicker({
    getSources: (opts) => desktopCapturer.getSources(opts),
    now: () => Date.now(),
    appOrigin,
    ownMediaSourceIds: () => [window.isDestroyed() ? null : window.getMediaSourceId(), toasts.mediaSourceId()].filter((id) => id !== null),
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
    identity: watchedIdentity,
    // A new global nickname is announced to the friends with an open link.
    settings: {
      get: () => settings.get(),
      set: (patch) => {
        const next = settings.set(patch);
        if (patch.nickname !== undefined) friends.nicknameChanged();
        if (patch.locale !== undefined) tray.refresh(); // the tray menu speaks the new language
        return next;
      },
    },
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
    showWindow: () => revealWindow(window),
    updates: updater,
    releaseNotes,
    ptt,
    appInfo: () => ({ version: app.getVersion(), platform: process.platform as Platform, locale: app.getLocale() }),
    host: { manager: host, copyText: (text) => clipboard.writeText(text), firewall: hostFirewall(host) },
    backup: identityBackup(window, watchedIdentity, controller),
    deepLinks: deepLinks ?? undefined,
    railway,
    friends,
    dm: friends.dm,
    profile: avatars.profile,
    attachments: attachments.ipc,
    screen: screenPicker,
    draw: drawOverlay,
    serverUpdates,
  });
  updater.start(); // the 6 h checks; the first one already ran behind the splash when it showed
  // After the update check at startup (the app runs its newest version by now), then every 30 min.
  // Installed apps only: a development build must not redeploy real servers on its own (opt in with
  // GHOSTLINK_SERVER_UPDATES=1); "Atualizar agora" works in both.
  // The same rule for erasing deleted servers: never on its own from a development build.
  if (!smoke && (app.isPackaged || process.env.GHOSTLINK_SERVER_UPDATES === '1')) {
    serverUpdates.start();
    deletions.start();
  }
  app.on('before-quit', () => {
    updater.dispose();
    serverUpdates.dispose();
    deletions?.dispose();
    void controller.disconnectAll();
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

/** Brings the main window back: from the tray, minimized, or behind other windows. */
function revealWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Host mode (spec §9), the tray and the window/quit rules (v0.3.2, as Discord): the tray icon
 * stays while the app runs; closing the window hides it when "Ao fechar, manter na bandeja" is
 * on, and always while hosting; "Sair" quits for real, stopping a hosted server first.
 */
function startHostMode(
  window: BrowserWindow,
  controller: ClientController,
  servers: SavedServersStore,
  settings: SettingsStore,
  send: (channel: string, payload: unknown) => void,
  notice: (text: string) => void,
): { host: HostManager; tray: AppTray } {
  const showWindow = () => revealWindow(window);
  const tray = new AppTray({ locale: () => settings.get().locale, onOpen: showWindow, onQuit: () => app.quit(), notice });
  tray.show();
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
    // Before the hosted server stops: its connection closes, on screen or the call's.
    leave: async (serverKeyId) => {
      const saved = servers.findByServerKeyId(serverKeyId);
      if (saved) await controller.closeServer(saved.id);
    },
    nickname: () => settings.get().nickname,
    emit: (status) => {
      send(IPC_EVENTS.host, status);
      tray.setHost(status);
    },
    bindHost: hostBind,
  });

  let quitting = false;
  let stoppedForQuit = false;
  window.on('close', (event) => {
    if (!shouldHideOnClose({ closeToTray: settings.get().closeToTray, hosting: host.isActive(), quitting })) return;
    event.preventDefault();
    window.hide(); // a call goes on: the page keeps running, hidden
    if (settings.trayNoticeShown()) return;
    tray.notifyKeptRunning(); // once ever
    try {
      settings.markTrayNoticeShown();
    } catch (e) {
      mainLog.warn('[tray] could not remember that the notice was shown:', e);
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
  return { host, tray };
}

/**
 * Where "Baixar" saves (anexos §1): the system's save dialog, starting in Downloads with the file's
 * name. Test hook (never honoured when packaged): GHOSTLINK_E2E_SAVE_DIR saves there without a
 * dialog, so end-to-end runs never block on a native window.
 */
function attachmentSavePath(window: BrowserWindow): (name: string) => Promise<string | null> {
  const testDir = app.isPackaged ? undefined : process.env.GHOSTLINK_E2E_SAVE_DIR || undefined;
  if (testDir) return async (name) => join(resolve(testDir), basename(name));
  return async (name) => {
    const r = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath('downloads'), name) });
    return r.canceled || !r.filePath ? null : r.filePath;
  };
}

/** spec §3.4: .ghostkey export/import through the native dialogs; the seed stays in this process. */
function identityBackup(window: BrowserWindow, identity: IdentityBackupDeps['identity'], controller: ClientController): IdentityBackup {
  const filters = [{ name: 'GhostLink', extensions: [GHOSTKEY_EXTENSION] }];
  return new IdentityBackup({
    identity,
    disconnect: () => controller.disconnectAll(),
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
    // Loaded only here: the native modules of the P2P stack must never be needed just to start the app.
    p2p: async () => (await import('./p2p/selfTest.js')).p2pSelfTest(),
    exit: (code) => app.exit(code),
    // `npm run smoke` reads "smoke: OK" from stdout; in development the log mirror prints it.
    log: (message) => {
      mainLog.info(message);
      if (app.isPackaged) safeWrite(process.stdout, `${message}\n`);
    },
  });
}
