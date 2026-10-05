// Servers follow the app's version (v0.2.2, spec 2026-10-01 §3, §5): the state of a Railway
// server this app created, and "Atualizar agora". ipc.ts registers them with the same sender
// check → zod → handler pipeline as every other channel.
import { z } from 'zod';
import { IPC, type IpcArgs, type IpcReturn, type ServerUpdatesIpcChannel } from '../shared/ipcTypes.js';
import type { ServerUpdates } from './railway/serverUpdates.js';

export type ServerUpdatesIpcDeps = Pick<ServerUpdates, 'state' | 'updateNow'>;

const serverKeyId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const SERVER_UPDATES_IPC_ARG_SCHEMAS: { readonly [C in ServerUpdatesIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.serverUpdatesState]: z.tuple([serverKeyId]),
  [IPC.serverUpdatesUpdateNow]: z.tuple([serverKeyId]),
};

type ServerUpdatesHandlers = { [C in ServerUpdatesIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createServerUpdatesIpcHandlers(deps: ServerUpdatesIpcDeps | undefined): ServerUpdatesHandlers {
  return {
    // Not wired (tests): no server is managed.
    [IPC.serverUpdatesState]: (id) => deps?.state(id) ?? null,
    [IPC.serverUpdatesUpdateNow]: (id) => {
      if (!deps) throw new Error('Server updates are not wired');
      return deps.updateNow(id);
    },
  };
}
