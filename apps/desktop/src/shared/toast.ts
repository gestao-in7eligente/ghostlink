// GhostLink's own notification cards (spec 2026-10-02-notificacoes-design.md): main (toasts.ts) →
// page the cards to show, page → main a click, a close or the mouse over them. Only main and the
// cards' preload import the channel names, so the main window's preload never shares a chunk with it.
import type { Locale } from './ipcTypes.js';

export const TOAST_CHANNELS = {
  update: 'toast:update',
  click: 'toast:click',
  close: 'toast:close',
  hover: 'toast:hover',
} as const;

/**
 * The round picture on the left: a server's icon (served at app://ghostlink/_avatar/<hash>, with the
 * initials shown when it does not load), a person's or server's initials, or the ghost (the app's own notices).
 */
export type ToastIcon = { kind: 'image'; url: string; fallback: string } | { kind: 'initials'; text: string } | { kind: 'ghost' };

/** One card, its text already clean (one line each, bounded): line 1 the title, then "Autor: texto". */
export interface ToastView {
  id: number;
  icon: ToastIcon;
  title: string;
  /** Before the text, in the link color; null for direct messages and the app's notices. */
  author: string | null;
  body: string;
}

/** Everything the page shows, oldest card first (the newest is at the bottom). */
export interface ToastUpdate {
  lang: Locale;
  /** The × button's accessible name, in the saved language. */
  closeLabel: string;
  toasts: ToastView[];
}

/** window.ghostlinkToast, exposed by the cards' preload. */
export interface ToastPageApi {
  /** Called with the latest cards right away (when there are some) and on every change. */
  onUpdate(cb: (update: ToastUpdate) => void): void;
  /** The card was clicked: GhostLink opens on what it is about, and the card goes. */
  click(id: number): void;
  /** Its ×. */
  close(id: number): void;
  /** The mouse is over the cards (none of them leaves meanwhile) or left them. */
  hover(on: boolean): void;
}
