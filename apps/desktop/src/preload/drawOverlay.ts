// Sandboxed preload of the pencil's overlay (main/drawOverlay.ts): it only receives the strokes to
// draw, and sends nothing. Like the other preloads, it imports only `electron` and a module of its
// own, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer } from 'electron';
import { DRAW_OVERLAY_CHANNELS, type DrawOverlayPageApi, type OverlayStroke } from '../shared/drawOverlay.js';

// Listening from the start keeps the batches that arrive before the page subscribes.
const early: OverlayStroke[] = [];
let listener: ((stroke: OverlayStroke) => void) | null = null;
ipcRenderer.on(DRAW_OVERLAY_CHANNELS.stroke, (_event, stroke: OverlayStroke) => {
  if (listener) listener(stroke);
  else if (early.length < 256) early.push(stroke);
});

const api: DrawOverlayPageApi = {
  onStroke: (cb) => {
    listener = cb;
    for (const stroke of early.splice(0)) cb(stroke);
  },
};

contextBridge.exposeInMainWorld('ghostlinkDrawOverlay', api);
