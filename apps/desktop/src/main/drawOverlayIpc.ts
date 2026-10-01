// The pencil overlay's channels (spec 2026-10-01-lapis-na-tela-design.md §4). ipc.ts registers them
// with the same sender check → zod → handler pipeline as every other channel.
import { z } from 'zod';
import { SCREEN_DRAW_LIMITS, drawPointSchema } from '@ghostlink/shared';
import { IPC, type IpcArgs, type IpcChannel, type IpcReturn } from '../shared/ipcTypes.js';
import type { DrawOverlay } from './drawOverlay.js';

export type DrawIpcChannel = Extract<IpcChannel, `ghostlink:draw.${string}`>;

export type DrawIpcDeps = Pick<DrawOverlay, 'open' | 'stroke' | 'close'>;

const overlayStroke = z.strictObject({
  // `${userId}:${strokeId}`
  id: z.string().regex(/^[0-9a-f]{32}:[A-Za-z0-9_-]{1,32}$/),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  label: z.string().max(256),
  // The renderer's own end of a stroke may come without a new point.
  points: z.array(drawPointSchema).max(SCREEN_DRAW_LIMITS.maxPoints),
  end: z.boolean(),
});

export const DRAW_IPC_ARG_SCHEMAS: { readonly [C in DrawIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.drawOverlayOpen]: z.tuple([]),
  [IPC.drawOverlayStroke]: z.tuple([overlayStroke]),
  [IPC.drawOverlayClose]: z.tuple([]),
};

type DrawHandlers = { [C in DrawIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createDrawIpcHandlers(deps: DrawIpcDeps | undefined): DrawHandlers {
  return {
    // Without an overlay (tests, other platforms) there is simply none.
    [IPC.drawOverlayOpen]: () => deps?.open() ?? false,
    [IPC.drawOverlayStroke]: (stroke) => deps?.stroke(stroke),
    [IPC.drawOverlayClose]: () => deps?.close(),
  };
}
