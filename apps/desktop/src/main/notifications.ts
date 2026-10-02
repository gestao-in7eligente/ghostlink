import type { ChatNotification, Locale, OpenChannelEvent } from '../shared/ipcTypes.js';
import { notifications as notificationsEn } from '../renderer/i18n/notifications.en.js';
import { notifications as notificationsPtBR } from '../renderer/i18n/notifications.pt-BR.js';
import type { DmNotification } from './p2p/dm.js';

const TITLE_MAX = 64;
const BODY_MAX = 200;
/** Toasts kept alive for their click handler; the oldest go first (Windows may never send 'close'). */
export const MAX_LIVE_NOTIFICATIONS = 20;

/** One line of plain text: no control characters, collapsed spaces, bounded length. */
export function notificationText(raw: string, max: number): string {
  const clean = raw.replace(/\p{Cc}|\p{Cf}/gu, ' ').replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

type NotificationsKey = keyof typeof notificationsPtBR;

/** The notifications' texts come from the renderer's catalogs (pure data), as the tray's do. */
export function notificationsText(locale: Locale, key: NotificationsKey, vars: Readonly<Record<string, string>> = {}): string {
  const template: string = (locale === 'pt-BR' ? notificationsPtBR : notificationsEn)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : match));
}

export interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
}

export interface NotifierWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface NotifierDeps {
  isSupported(): boolean;
  create(options: { title: string; body: string; silent: boolean }): NativeNotification;
  window(): NotifierWindow | null;
  openChannel(event: OpenChannelEvent): void;
  /** A direct message's notification was clicked: show that conversation. */
  openConversation(conv: string): void;
}

/**
 * Windows notifications for mentions and replies (spec §11.1 item 8) and for direct messages
 * from friends (friends spec §8). The renderer decides which channel messages deserve one, the
 * friends engine which direct messages; the main process shows them only while the window is
 * not focused, and a click brings the window back on that channel or conversation.
 */
export class ChatNotifier {
  /** Kept alive until closed (a collected Notification loses its click handler), newest last, bounded. */
  readonly #live = new Set<NativeNotification>();

  constructor(private readonly deps: NotifierDeps) {}

  show(n: ChatNotification): boolean {
    return this.#show(n.title, n.body, () => this.deps.openChannel({ channelId: n.channelId }));
  }

  /** A message from a friend: their name and the text. Never logged. */
  showDm(n: DmNotification): boolean {
    return this.#show(n.title, n.body, () => this.deps.openConversation(n.conv));
  }

  #show(rawTitle: string, rawBody: string, open: () => void): boolean {
    const win = this.deps.window();
    if (!win || win.isDestroyed() || win.isFocused() || !this.deps.isSupported()) return false;
    const title = notificationText(rawTitle, TITLE_MAX);
    const body = notificationText(rawBody, BODY_MAX);
    if (title === '') return false;
    const note = this.deps.create({ title, body, silent: false });
    this.#live.add(note);
    while (this.#live.size > MAX_LIVE_NOTIFICATIONS) this.#live.delete(this.#live.values().next().value!);
    note.on('click', () => {
      this.#live.delete(note);
      const w = this.deps.window();
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      open();
    });
    note.on('close', () => this.#live.delete(note));
    note.on('failed', () => this.#live.delete(note));
    note.show();
    return true;
  }

  get pending(): number {
    return this.#live.size;
  }
}
