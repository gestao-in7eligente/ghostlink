import { ipcMain, type WebFrameMain } from 'electron';
import { z } from 'zod';
import { LIMITS } from '@ghostlink/shared';
import { toAppErrorCode } from '../shared/appErrors.js';
import { IPC, type AppInfo, type ChatNotification, type IpcArgs, type IpcChannel, type IpcResult, type IpcReturn } from '../shared/ipcTypes.js';
import type { ClientController } from './controller.js';
import { BACKUP_IPC_ARG_SCHEMAS, createBackupIpcHandlers, type IdentityBackup } from './backup.js';
import type { DeepLinks } from './deeplink.js';
import { DRAW_IPC_ARG_SCHEMAS, createDrawIpcHandlers, type DrawIpcDeps } from './drawOverlayIpc.js';
import { HOST_IPC_ARG_SCHEMAS, createHostIpcHandlers, type HostIpcDeps } from './hostIpc.js';
import type { IdentityStore } from './identity.js';
import { mainLog } from './log.js';
import type { PushToTalk } from './ptt.js';
import { PROFILE_IPC_ARG_SCHEMAS, createProfileIpcHandlers, type ProfileIpcDeps } from './profileIpc.js';
import { RAILWAY_IPC_ARG_SCHEMAS, createRailwayIpcHandlers, type RailwayIpcDeps } from './railwayIpc.js';
import { SCREEN_IPC_ARG_SCHEMAS, createScreenIpcHandlers, type ScreenIpcDeps } from './screenIpc.js';
import { SERVER_UPDATES_IPC_ARG_SCHEMAS, createServerUpdatesIpcHandlers, type ServerUpdatesIpcDeps } from './serverUpdatesIpc.js';
import { originOf } from './security.js';
import { LOCALES, type SettingsStore } from './settings.js';
import type { Updater } from './updater.js';

export interface IpcDeps {
  /** app://ghostlink, or the dev server origin in development. */
  appOrigin: string;
  appInfo(): AppInfo;
  identity: Pick<IdentityStore, 'status' | 'create' | 'retry' | 'replaceKeepingBackup'>;
  settings: Pick<SettingsStore, 'get' | 'set'>;
  controller: Pick<ClientController, 'parse' | 'probe' | 'join' | 'list' | 'connectSaved' | 'disconnect' | 'remove' | 'request'>;
  /** Host mode (spec §9). */
  host?: HostIpcDeps;
  /** Identity backup, import and delete (spec §3.4). */
  backup?: IdentityBackup;
  /** ghostlink:// links (spec §12). */
  deepLinks?: Pick<DeepLinks, 'take'>;
  /** Confirmed external links and the clipboard (Text track). */
  shell: { openExternal(url: string): Promise<boolean>; copyText(text: string): void };
  notifications: { show(n: ChatNotification): boolean };
  updates: Pick<Updater, 'state' | 'setAutoCheck' | 'checkNow' | 'restart'>;
  /** Global push-to-talk (voice track). */
  ptt: Pick<PushToTalk, 'configure'>;
  /** "Criar um servidor" on Railway (v0.2). */
  railway?: RailwayIpcDeps;
  /** The profile photo (v0.2.2). */
  profile?: ProfileIpcDeps;
  /** Screen sharing: the sources and the choice (screen sharing spec §3). */
  screen?: ScreenIpcDeps;
  /** The pencil's overlay over the shared monitor (pencil spec §4). */
  draw?: DrawIpcDeps;
  /** The Railway servers this app created follow its version (v0.2.2). */
  serverUpdates?: ServerUpdatesIpcDeps;
}

/** The handshake belongs to the main process alone: the renderer may never send it (release plan "Seams"). */
export const FORBIDDEN_REQUEST_TYPES: ReadonlySet<string> = new Set(['hello', 'auth.proof']);

/**
 * The client requests of spec §5.2 the renderer may send, and nothing else: never
 * the handshake, a response or an event type, nor anything only main should drive.
 * `upload.begin` joins with files (v0.2).
 */
export const RENDERER_REQUEST_TYPES: ReadonlySet<string> = new Set([
  // Text track
  'channel.create', 'channel.update', 'channel.delete', 'channel.reorder', 'channel.read',
  'msg.history', 'msg.send', 'msg.edit', 'msg.delete', 'msg.react', 'msg.unreact', 'typing',
  'profile.update', 'role.create', 'role.update', 'role.delete', 'role.reorder',
  'member.setRoles', 'member.kick', 'member.ban', 'member.unban', 'bans.list',
  'invite.create', 'invite.list', 'invite.revoke', 'server.update', 'server.transferOwnership', 'server.leave',
  // Voice track
  'voice.join', 'voice.leave', 'voice.selfState', 'voice.moderate',
  // The pencil on shared screens (v0.2.3)
  'screen.draw', 'screen.drawAllow',
  'ping',
]);

/** A server request type the renderer may send (see RENDERER_REQUEST_TYPES). */
export const requestTypeSchema = z
  .string()
  .max(64)
  .refine((t) => RENDERER_REQUEST_TYPES.has(t) && !FORBIDDEN_REQUEST_TYPES.has(t));

/** A JSON object no bigger than a server frame (spec §5.1: maxPayload 256 KiB, counted in UTF-8 bytes). */
const requestPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((d) => {
    try {
      return Buffer.byteLength(JSON.stringify(d), 'utf8') <= LIMITS.maxPayloadBytes;
    } catch {
      return false;
    }
  })
  .optional();

/** The saved server the renderer believes it talks to (a request for another one is refused). */
const expectedServerId = z.string().min(1).max(64);

// Renderer input is untrusted: strict schemas, bounded sizes. The deeper rules
// (address syntax, nickname normalization) are enforced again where the data is used.
const address = z.string().min(1).max(262);
const serverKeyId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const serverId = z.string().min(1).max(64);

export const IPC_ARG_SCHEMAS: { readonly [C in IpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.appInfo]: z.tuple([]),
  [IPC.appOpenExternal]: z.tuple([z.string().min(1).max(2048)]),
  [IPC.appCopyText]: z.tuple([z.string().max(8192)]),
  [IPC.serverRequest]: z.union([
    z.tuple([requestTypeSchema]),
    z.tuple([requestTypeSchema, requestPayloadSchema]),
    z.tuple([requestTypeSchema, requestPayloadSchema, expectedServerId]),
  ]),
  [IPC.notificationsShow]: z.tuple([
    z.strictObject({ title: z.string().min(1).max(256), body: z.string().max(4096), channelId: z.string().regex(/^[A-Z2-7]{26}$/) }),
  ]),
  [IPC.identityStatus]: z.tuple([]),
  [IPC.identityCreate]: z.tuple([]),
  [IPC.identityRetry]: z.tuple([]),
  [IPC.identityReplaceKeepingBackup]: z.tuple([]),
  [IPC.settingsGet]: z.tuple([]),
  [IPC.settingsSet]: z.tuple([z.strictObject({ locale: z.enum(LOCALES).optional(), nickname: z.string().max(256).optional() })]),
  [IPC.joinParse]: z.tuple([z.string().max(2 * LIMITS.inviteMaxLength)]),
  [IPC.joinProbe]: z.tuple([address]),
  [IPC.joinConnect]: z.tuple([
    z.strictObject({
      addresses: z.array(address).min(1).max(LIMITS.inviteMaxAddresses),
      serverKeyId,
      inviteCode: z.string().min(1).max(64).optional(),
      password: z.string().min(1).max(256).optional(),
      setupCode: z.string().min(1).max(64).optional(),
      nickname: z.string().min(1).max(64),
      name: z.string().max(256).optional(),
    }),
  ]),
  [IPC.serversList]: z.tuple([]),
  [IPC.serversConnect]: z.tuple([serverId]),
  [IPC.serversDisconnect]: z.tuple([]),
  [IPC.serversRemove]: z.tuple([serverId]),
  ...HOST_IPC_ARG_SCHEMAS,
  ...BACKUP_IPC_ARG_SCHEMAS,
  ...RAILWAY_IPC_ARG_SCHEMAS,
  ...PROFILE_IPC_ARG_SCHEMAS,
  ...SCREEN_IPC_ARG_SCHEMAS,
  ...DRAW_IPC_ARG_SCHEMAS,
  ...SERVER_UPDATES_IPC_ARG_SCHEMAS,
  [IPC.deepLinkTake]: z.tuple([]),
  [IPC.updatesState]: z.tuple([]),
  [IPC.updatesSetAutoCheck]: z.tuple([z.boolean()]),
  [IPC.updatesCheckNow]: z.tuple([]),
  [IPC.updatesRestart]: z.tuple([]),
  // A DOM KeyboardEvent.code such as "KeyV" or "ControlRight"; main maps it to the hook's keycode.
  [IPC.pttConfigure]: z.tuple([z.strictObject({ enabled: z.boolean(), code: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/).nullable() })]),
};

type Handlers = { [C in IpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createIpcHandlers(deps: IpcDeps): Handlers {
  const { identity, settings, controller, updates } = deps;
  return {
    [IPC.appInfo]: () => deps.appInfo(),
    [IPC.appOpenExternal]: (url) => deps.shell.openExternal(url),
    [IPC.appCopyText]: (text) => deps.shell.copyText(text),
    [IPC.serverRequest]: (type, payload, serverId) => controller.request(type, payload ?? {}, serverId),
    [IPC.notificationsShow]: (n) => deps.notifications.show(n),
    [IPC.identityStatus]: () => identity.status,
    [IPC.identityCreate]: () => identity.create(),
    [IPC.identityRetry]: () => identity.retry(),
    [IPC.identityReplaceKeepingBackup]: () => identity.replaceKeepingBackup(),
    [IPC.settingsGet]: () => settings.get(),
    [IPC.settingsSet]: (patch) => settings.set(patch),
    [IPC.joinParse]: (input) => controller.parse(input),
    [IPC.joinProbe]: (addr) => controller.probe(addr),
    [IPC.joinConnect]: (req) => controller.join(req),
    [IPC.serversList]: () => controller.list(),
    [IPC.serversConnect]: (id) => controller.connectSaved(id),
    [IPC.serversDisconnect]: () => controller.disconnect(),
    [IPC.serversRemove]: (id) => controller.remove(id),
    ...createHostIpcHandlers(deps.host),
    ...createBackupIpcHandlers(deps.backup),
    ...createRailwayIpcHandlers(deps.railway),
    ...createProfileIpcHandlers(deps.profile),
    ...createScreenIpcHandlers(deps.screen),
    ...createDrawIpcHandlers(deps.draw),
    ...createServerUpdatesIpcHandlers(deps.serverUpdates),
    [IPC.deepLinkTake]: () => deps.deepLinks?.take() ?? null,
    [IPC.updatesState]: () => updates.state(),
    [IPC.updatesSetAutoCheck]: (enabled) => updates.setAutoCheck(enabled),
    [IPC.updatesCheckNow]: async () => {
      await updates.checkNow(); // never throws; skipped while a check runs or an update waits
      return updates.state();
    },
    [IPC.updatesRestart]: () => updates.restart(),
    [IPC.pttConfigure]: (config) => deps.ptt.configure(config),
  };
}

/** Only the app's own top-level page may call (spec §12): not iframes, not other origins. */
export function isTrustedSender(frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined, appOrigin: string): boolean {
  return frame !== null && frame !== undefined && frame.parent === null && originOf(frame.url) === appOrigin;
}

/**
 * Sender check → zod → handler. Never throws: failures resolve as `{ ok: false, code }`
 * with an app error code, so no internal message or stack crosses the IPC boundary.
 */
export async function dispatchIpc<C extends IpcChannel>(
  channel: C,
  frame: Pick<WebFrameMain, 'url' | 'parent'> | null | undefined,
  args: unknown[],
  handlers: Handlers,
  appOrigin: string,
): Promise<IpcResult<IpcReturn<C>>> {
  if (!isTrustedSender(frame, appOrigin)) return { ok: false, code: 'FORBIDDEN' };
  const parsed = IPC_ARG_SCHEMAS[channel].safeParse(args);
  if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' };
  const handler = handlers[channel] as (...a: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>>;
  try {
    return { ok: true, value: await handler(...parsed.data) };
  } catch (e) {
    const code = toAppErrorCode(e);
    if (code === 'INTERNAL') mainLog.error(`[ipc] ${channel} failed:`, e);
    return { ok: false, code };
  }
}

/** Step 5 of the bootstrap: one ipcMain.handle per channel of the contract. */
export function registerIpc(deps: IpcDeps): void {
  const handlers = createIpcHandlers(deps);
  for (const channel of Object.values(IPC)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => dispatchIpc(channel, event.senderFrame, args, handlers, deps.appOrigin));
  }
}
