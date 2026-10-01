// The friends channels (v0.3, friends spec §9). ipc.ts registers them with the same
// sender check → zod → handler pipeline as every other channel. Keys cross as base64url of
// 32 bytes; a friend code crosses as the person pasted it, and the engine validates it.
import { z } from 'zod';
import { FRIEND_LOCAL_NAME_MAX } from '../shared/friendsTypes.js';
import { IPC, type FriendsIpcChannel, type IpcArgs, type IpcReturn } from '../shared/ipcTypes.js';
import type { FriendsEngine } from './p2p/engine.js';

export type FriendsIpcDeps = Pick<FriendsEngine, 'state' | 'add' | 'accept' | 'dismiss' | 'remove' | 'block' | 'rename' | 'newCode' | 'setInbox' | 'setAvailable'>;

/** Longer than any code with dashes and stray spaces (109 characters), and nothing more. */
export const FRIEND_CODE_INPUT_MAX = 200;

const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const localName = z.string().trim().min(1).max(FRIEND_LOCAL_NAME_MAX).nullable();

export const FRIENDS_IPC_ARG_SCHEMAS: { readonly [C in FriendsIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.friendsState]: z.tuple([]),
  [IPC.friendsAdd]: z.tuple([z.string().max(FRIEND_CODE_INPUT_MAX)]),
  [IPC.friendsAccept]: z.tuple([key]),
  [IPC.friendsDismiss]: z.tuple([key]),
  [IPC.friendsRemove]: z.tuple([key]),
  [IPC.friendsBlock]: z.tuple([key]),
  [IPC.friendsRename]: z.tuple([key, localName]),
  [IPC.friendsNewCode]: z.tuple([]),
  [IPC.friendsSetInbox]: z.tuple([z.boolean()]),
  [IPC.friendsSetAvailable]: z.tuple([z.boolean()]),
};

type FriendsHandlers = { [C in FriendsIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createFriendsIpcHandlers(deps: FriendsIpcDeps | undefined): FriendsHandlers {
  const friends = () => {
    if (!deps) throw new Error('the friends engine is not wired');
    return deps;
  };
  return {
    [IPC.friendsState]: () => friends().state(),
    [IPC.friendsAdd]: (code) => friends().add(code),
    [IPC.friendsAccept]: (friendKey) => friends().accept(friendKey),
    [IPC.friendsDismiss]: (friendKey) => friends().dismiss(friendKey),
    [IPC.friendsRemove]: (friendKey) => friends().remove(friendKey),
    [IPC.friendsBlock]: (friendKey) => friends().block(friendKey),
    [IPC.friendsRename]: (friendKey, name) => friends().rename(friendKey, name),
    [IPC.friendsNewCode]: () => friends().newCode(),
    [IPC.friendsSetInbox]: (enabled) => friends().setInbox(enabled),
    [IPC.friendsSetAvailable]: (enabled) => friends().setAvailable(enabled),
  };
}
