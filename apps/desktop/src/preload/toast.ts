// Sandboxed preload of the notification cards (main/toasts.ts): it receives the cards to show and
// sends a click, a close or the mouse over them, nothing else. Like the other preloads, it imports
// only `electron` and a module of its own, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer } from 'electron';
import { TOAST_CHANNELS, type ToastPageApi, type ToastUpdate } from '../shared/toast.js';

// Listening from the start keeps the cards that arrive before the page subscribes.
let latest: ToastUpdate | null = null;
let listener: ((update: ToastUpdate) => void) | null = null;
ipcRenderer.on(TOAST_CHANNELS.update, (_event, update: ToastUpdate) => {
  latest = update;
  listener?.(update);
});

const api: ToastPageApi = {
  onUpdate: (cb) => {
    listener = cb;
    if (latest !== null) cb(latest);
  },
  click: (id) => ipcRenderer.send(TOAST_CHANNELS.click, id),
  close: (id) => ipcRenderer.send(TOAST_CHANNELS.close, id),
  hover: (on) => ipcRenderer.send(TOAST_CHANNELS.hover, on),
};

contextBridge.exposeInMainWorld('ghostlinkToast', api);
