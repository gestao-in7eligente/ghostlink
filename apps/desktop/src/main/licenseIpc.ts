// The license-key channels (v0.9). ipc.ts registers them with the same sender check → zod → handler
// pipeline as every other channel. The key only ever travels renderer → main (activate); nothing here
// returns it — only the license state (AppLicenseInfo).
import { z } from 'zod';
import { IPC, type IpcArgs, type IpcReturn, type LicenseIpcChannel } from '../shared/ipcTypes.js';
import type { LicenseManager } from './license/manager.js';

export type LicenseIpcDeps = Pick<LicenseManager, 'info' | 'activate' | 'clear'>;

export const LICENSE_IPC_ARG_SCHEMAS: { readonly [C in LicenseIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.licenseInfo]: z.tuple([]),
  [IPC.licenseActivate]: z.tuple([z.string().min(1).max(64)]),
  [IPC.licenseClear]: z.tuple([]),
};

type LicenseHandlers = { [C in LicenseIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createLicenseIpcHandlers(deps: LicenseIpcDeps | undefined): LicenseHandlers {
  const license = () => {
    if (!deps) throw new Error('License is not wired');
    return deps;
  };
  return {
    [IPC.licenseInfo]: () => license().info(),
    [IPC.licenseActivate]: (key) => license().activate(key),
    [IPC.licenseClear]: () => license().clear(),
  };
}
