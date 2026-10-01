// The profile photo channels (v0.2.2, spec 2026-10-01-foto-de-perfil §3). ipc.ts registers
// them with the same sender check → zod → handler pipeline as every other channel.
import { z } from 'zod';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import { IPC, type IpcArgs, type IpcReturn, type ProfileIpcChannel } from '../shared/ipcTypes.js';
import type { AvatarInfo } from '../shared/profileTypes.js';

export interface ProfileIpcDeps {
  avatar(): AvatarInfo | null | Promise<AvatarInfo | null>;
  setAvatar(bytes: Uint8Array): Promise<AvatarInfo>;
  clearAvatar(): Promise<null>;
}

export const PROFILE_IPC_ARG_SCHEMAS: { readonly [C in ProfileIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.profileAvatar]: z.tuple([]),
  // The bytes are checked again in main (type, sides); here only the shape and the size cap.
  [IPC.profileSetAvatar]: z.tuple([z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= AVATAR_LIMITS.maxBytes)]),
  [IPC.profileClearAvatar]: z.tuple([]),
};

type ProfileHandlers = { [C in ProfileIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createProfileIpcHandlers(deps: ProfileIpcDeps | undefined): ProfileHandlers {
  const profile = () => {
    if (!deps) throw new Error('Profile is not wired');
    return deps;
  };
  return {
    [IPC.profileAvatar]: () => profile().avatar(),
    [IPC.profileSetAvatar]: (bytes) => profile().setAvatar(bytes),
    [IPC.profileClearAvatar]: () => profile().clearAvatar(),
  };
}
