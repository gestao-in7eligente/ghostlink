// The direct-message channels (v0.3 phase 2, friends spec §4). ipc.ts registers them with the
// same sender check → zod → handler pipeline as every other channel. Conversation and message ids
// cross as 32 lowercase hex characters, a friend key as base64url of 32 bytes; text crosses as
// the person typed it, and main cleans it and checks its length (BAD_REQUEST).
import { z } from 'zod';
import { DM_TEXT_MAX } from '../shared/dmTypes.js';
import { IPC, type DmIpcChannel, type IpcArgs, type IpcReturn } from '../shared/ipcTypes.js';
import type { DmService } from './p2p/engine.js';

export type DmIpcDeps = DmService;

/** Room for spaces around the longest text main keeps, and nothing near an unbounded string. */
export const DM_TEXT_INPUT_MAX = 2 * DM_TEXT_MAX;
/** The most messages one history call may ask for. */
export const DM_HISTORY_LIMIT_MAX = 200;

const id = z.string().regex(/^[0-9a-f]{32}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const text = z.string().max(DM_TEXT_INPUT_MAX);
// zod 4: z.number() already refuses Infinity and NaN.
const ts = z.number();

export const DM_IPC_ARG_SCHEMAS: { readonly [C in DmIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.dmConversations]: z.tuple([]),
  [IPC.dmOpen]: z.tuple([key]),
  [IPC.dmHide]: z.tuple([id]),
  [IPC.dmHistory]: z.tuple([id, ts.nullable(), z.number().int().min(1).max(DM_HISTORY_LIMIT_MAX)]),
  [IPC.dmSend]: z.tuple([id, text, id.nullable()]),
  [IPC.dmEdit]: z.tuple([id, id, text]),
  [IPC.dmRemove]: z.tuple([id, id]),
  [IPC.dmRead]: z.tuple([id, ts]),
  [IPC.dmTyping]: z.tuple([id]),
};

type DmHandlers = { [C in DmIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createDmIpcHandlers(deps: DmIpcDeps | undefined): DmHandlers {
  const dm = () => {
    if (!deps) throw new Error('the direct messages are not wired');
    return deps;
  };
  return {
    [IPC.dmConversations]: () => dm().conversations(),
    [IPC.dmOpen]: (friendKey) => dm().open(friendKey),
    [IPC.dmHide]: (conv) => dm().hide(conv),
    [IPC.dmHistory]: (conv, before, limit) => dm().history(conv, before, limit),
    [IPC.dmSend]: (conv, body, replyTo) => dm().send(conv, body, replyTo),
    [IPC.dmEdit]: (conv, messageId, body) => dm().edit(conv, messageId, body),
    [IPC.dmRemove]: (conv, messageId) => dm().remove(conv, messageId),
    [IPC.dmRead]: (conv, at) => dm().read(conv, at),
    [IPC.dmTyping]: (conv) => dm().typing(conv),
  };
}
