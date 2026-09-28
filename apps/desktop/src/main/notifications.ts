import type { ChatNotification, OpenChannelEvent } from '../shared/ipcTypes.js';

const TITLE_MAX = 64;
const BODY_MAX = 200;
/** Toasts kept alive for their click handler; the oldest go first (Windows may never send 'close'). */
export const MAX_LIVE_NOTIFICATIONS = 20;

/** One line of plain text: no control characters, collapsed spaces, bounded length. */
export function notificationText(raw: string, max: number): string {
  const clean = raw.replace(/\p{Cc}|\p{Cf}/gu, ' ').replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
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
}

/**
 * Windows notifications for mentions and replies (spec §11.1 item 8). The
 * renderer decides what deserves one; the main process shows it only while the
 * window is not focused, and a click brings the window back on that channel.
 */
export class ChatNotifier {
  /** Kept alive until closed (a collected Notification loses its click handler), newest last, bounded. */
  readonly #live = new Set<NativeNotification>();

  constructor(private readonly deps: NotifierDeps) {}

  show(n: ChatNotification): boolean {
    const win = this.deps.window();
    if (!win || win.isDestroyed() || win.isFocused() || !this.deps.isSupported()) return false;
    const title = notificationText(n.title, TITLE_MAX);
    const body = notificationText(n.body, BODY_MAX);
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
      this.deps.openChannel({ channelId: n.channelId });
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
