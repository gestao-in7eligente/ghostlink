import { ipcMain, type WebFrameMain } from 'electron';
import { z } from 'zod';
import { LIMITS } from '@ghostlink/shared';
import { toAppErrorCode } from '../shared/appErrors.js';
import { IPC, type AppInfo, type IpcArgs, type IpcChannel, type IpcResult, type IpcReturn } from '../shared/ipcTypes.js';
import type { ClientController } from './controller.js';
import type { IdentityStore } from './identity.js';
import type { PushToTalk } from './ptt.js';
import { originOf } from './security.js';
import { LOCALES, type SettingsStore } from './settings.js';

export interface IpcDeps {
  /** app://ghostlink, or the dev server origin in development. */
  appOrigin: string;
  appInfo(): AppInfo;
  identity: Pick<IdentityStore, 'status' | 'create' | 'retry' | 'replaceKeepingBackup'>;
  settings: Pick<SettingsStore, 'get' | 'set'>;
  controller: Pick<ClientController, 'parse' | 'probe' | 'join' | 'list' | 'connectSaved' | 'disconnect' | 'remove' | 'request'>;
  /** Global push-to-talk (voice track). */
  ptt: Pick<PushToTalk, 'configure'>;
}

/** The handshake belongs to the main process alone: the renderer may never send it (release plan "Seams"). */
export const FORBIDDEN_REQUEST_TYPES: ReadonlySet<string> = new Set(['hello', 'auth.proof']);

/** A server request type: 1..64 chars like "msg.send" or "voice.join"; never a handshake step. */
export const requestTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/)
  .refine((t) => !FORBIDDEN_REQUEST_TYPES.has(t));

/** A JSON object no bigger than a server frame (spec §5.1: maxPayload 256 KiB). */
const requestPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((d) => {
    try {
      return JSON.stringify(d).length <= LIMITS.maxPayloadBytes;
    } catch {
      return false;
    }
  })
  .optional();

// Renderer input is untrusted: strict schemas, bounded sizes. The deeper rules
// (address syntax, nickname normalization) are enforced again where the data is used.
const address = z.string().min(1).max(262);
const serverKeyId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const serverId = z.string().min(1).max(64);

export const IPC_ARG_SCHEMAS: { readonly [C in IpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.appInfo]: z.tuple([]),
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
  [IPC.serverRequest]: z.union([z.tuple([requestTypeSchema]), z.tuple([requestTypeSchema, requestPayloadSchema])]),
  // A DOM KeyboardEvent.code such as "KeyV" or "ControlRight"; main maps it to the hook's keycode.
  [IPC.pttConfigure]: z.tuple([z.strictObject({ enabled: z.boolean(), code: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/).nullable() })]),
};

type Handlers = { [C in IpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createIpcHandlers(deps: IpcDeps): Handlers {
  const { identity, settings, controller } = deps;
  return {
    [IPC.appInfo]: () => deps.appInfo(),
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
    [IPC.serverRequest]: (type, payload) => controller.request(type, payload ?? {}),
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
    if (code === 'INTERNAL') console.error(`[ipc] ${channel} failed:`, e);
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
