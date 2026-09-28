// The Host mode IPC channels (spec §9). ipc.ts registers them with the same
// sender check → zod → handler pipeline as every other channel.
import { z } from 'zod';
import { IPC, type HostIpcChannel, type IpcArgs, type IpcReturn } from '../shared/ipcTypes.js';
import { HOST_MAX_MEMBERS, HOST_PORT_MIN, type HostManager } from './hostManager.js';

export interface HostIpcDeps {
  manager: Pick<HostManager, 'refresh' | 'start' | 'stop' | 'restart' | 'join' | 'recoverOwnership' | 'invite' | 'logs'>;
  /** electron.clipboard.writeText in production. */
  copyText(text: string): void;
}

/** Big enough for any invite (LIMITS.inviteMaxLength is 2048) or fingerprint; nothing more. */
export const COPY_TEXT_MAX = 4_096;

export const HOST_IPC_ARG_SCHEMAS: { readonly [C in HostIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.hostStatus]: z.tuple([]),
  [IPC.hostStart]: z.tuple([
    z.strictObject({
      name: z.string().min(1).max(256),
      port: z.number().int().min(HOST_PORT_MIN).max(65535),
      joinMode: z.enum(['invite', 'open']),
      maxMembers: z.number().int().min(1).max(HOST_MAX_MEMBERS),
    }),
  ]),
  [IPC.hostStop]: z.tuple([]),
  [IPC.hostRestart]: z.tuple([]),
  [IPC.hostJoin]: z.tuple([]),
  [IPC.hostRecoverOwnership]: z.tuple([]),
  [IPC.hostInvite]: z.tuple([
    z.strictObject({
      maxUses: z.number().int().min(1).max(10_000).optional(),
      expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
    }),
  ]),
  [IPC.hostLogs]: z.tuple([]),
  [IPC.hostCopyText]: z.tuple([z.string().min(1).max(COPY_TEXT_MAX)]),
};

type HostHandlers = { [C in HostIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createHostIpcHandlers(deps: HostIpcDeps | undefined): HostHandlers {
  const manager = () => {
    if (!deps) throw new Error('Host mode is not wired');
    return deps.manager;
  };
  return {
    [IPC.hostStatus]: () => manager().refresh(),
    [IPC.hostStart]: (config) => manager().start(config),
    [IPC.hostStop]: () => manager().stop(),
    [IPC.hostRestart]: () => manager().restart(),
    [IPC.hostJoin]: () => manager().join(),
    [IPC.hostRecoverOwnership]: () => manager().recoverOwnership(),
    [IPC.hostInvite]: (opts) => manager().invite(opts),
    [IPC.hostLogs]: () => manager().logs(),
    [IPC.hostCopyText]: (text) => {
      if (!deps) throw new Error('Host mode is not wired');
      deps.copyText(text);
    },
  };
}
