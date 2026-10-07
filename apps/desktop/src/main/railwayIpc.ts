// The Railway provisioning channels (v0.2). ipc.ts registers them with the same
// sender check → zod → handler pipeline as every other channel. The token only ever
// travels renderer → main (connect); nothing here returns it.
import { z } from 'zod';
import { IPC, type IpcArgs, type IpcReturn, type RailwayIpcChannel } from '../shared/ipcTypes.js';
import { RAILWAY_REGIONS } from '../shared/railwayTypes.js';
import type { RailwayProvisioner } from './railway/provisioner.js';

export type RailwayIpcDeps = Pick<RailwayProvisioner, 'status' | 'connect' | 'test' | 'disconnect' | 'create' | 'pending' | 'resume' | 'discard'>;

export const RAILWAY_IPC_ARG_SCHEMAS: { readonly [C in RailwayIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.railwayStatus]: z.tuple([]),
  [IPC.railwayConnect]: z.tuple([z.string().min(1).max(512)]),
  [IPC.railwayTest]: z.tuple([z.string().min(1).max(512)]),
  [IPC.railwayDisconnect]: z.tuple([]),
  [IPC.railwayCreate]: z.tuple([
    z.strictObject({
      workspaceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
      name: z.string().trim().min(1).max(64),
      region: z.enum(RAILWAY_REGIONS),
      // The same rule as JoinConnectRequest.nickname in ipc.ts; the server normalizes it.
      nickname: z.string().min(1).max(64),
    }),
  ]),
  [IPC.railwayPending]: z.tuple([]),
  [IPC.railwayResume]: z.tuple([]),
  [IPC.railwayDiscard]: z.tuple([]),
};

type RailwayHandlers = { [C in RailwayIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createRailwayIpcHandlers(deps: RailwayIpcDeps | undefined): RailwayHandlers {
  const railway = () => {
    if (!deps) throw new Error('Railway is not wired');
    return deps;
  };
  return {
    [IPC.railwayStatus]: () => railway().status(),
    [IPC.railwayConnect]: (token) => railway().connect(token),
    [IPC.railwayTest]: (token) => railway().test(token),
    [IPC.railwayDisconnect]: () => railway().disconnect(),
    [IPC.railwayCreate]: (req) => railway().create(req),
    [IPC.railwayPending]: () => railway().pending(),
    [IPC.railwayResume]: () => railway().resume(),
    [IPC.railwayDiscard]: () => railway().discard(),
  };
}
