// The screen sharing channels (spec 2026-10-01-transmitir-tela-design.md §3). ipc.ts registers
// them with the same sender check → zod → handler pipeline as every other channel.
import { z } from 'zod';
import { IPC, type IpcArgs, type IpcChannel, type IpcReturn } from '../shared/ipcTypes.js';
import { SCREEN_SOURCE_ID } from '../shared/screenTypes.js';
import type { ScreenPicker } from './screenPicker.js';

export type ScreenIpcChannel = Extract<IpcChannel, `ghostlink:screen.${string}`>;

export type ScreenIpcDeps = Pick<ScreenPicker, 'listSources' | 'choose'>;

export const SCREEN_IPC_ARG_SCHEMAS: { readonly [C in ScreenIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.screenSources]: z.tuple([]),
  // A desktopCapturer id; 64 characters fit two 64-bit numbers.
  [IPC.screenChoose]: z.tuple([z.strictObject({ sourceId: z.string().max(64).regex(SCREEN_SOURCE_ID), audio: z.boolean() })]),
};

type ScreenHandlers = { [C in ScreenIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createScreenIpcHandlers(deps: ScreenIpcDeps | undefined): ScreenHandlers {
  const picker = () => {
    if (!deps) throw new Error('Screen sharing is not wired');
    return deps;
  };
  return {
    [IPC.screenSources]: () => picker().listSources(),
    [IPC.screenChoose]: (choice) => picker().choose(choice),
  };
}
