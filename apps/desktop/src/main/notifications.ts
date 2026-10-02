import { APP_NAME } from '@ghostlink/shared';
import type { Friend, FriendsSnapshot } from '../shared/friendsTypes.js';
import type { ChatNotification, Locale, OpenChannelEvent } from '../shared/ipcTypes.js';
import { avatarUrl } from '../shared/profileTypes.js';
import type { ToastIcon } from '../shared/toast.js';
import { formatShortCode } from '../renderer/features/friends/friendsModel.js';
import { notifications as notificationsEn } from '../renderer/i18n/notifications.en.js';
import { notifications as notificationsPtBR } from '../renderer/i18n/notifications.pt-BR.js';
import { serverInitials } from '../renderer/layout/names.js';
import type { DmNotification } from './p2p/dm.js';
import type { ToastInput } from './toasts.js';

const TITLE_MAX = 64;
const BODY_MAX = 200;
/** Toasts kept alive for their click handler; the oldest go first (the system may never send 'close'). */
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

/** macOS keeps the system's notifications (as Discord does there); Windows and Linux get GhostLink's own cards. */
export function usesOwnCards(platform: string): boolean {
  return platform !== 'darwin';
}

/**
 * The requests in `next` that were not waiting in `previous`. The first snapshot, and the first one
 * of another identity (or after a new friend code), only note what is already there: a request that
 * was waiting before has its badge on "Amigos", not a card.
 */
export function newFriendRequests(previous: FriendsSnapshot | null, next: FriendsSnapshot): Friend[] {
  if (previous === null || previous.code !== next.code) return [];
  const waiting = new Set(previous.friends.filter((f) => f.state === 'pending_in').map((f) => f.key));
  return next.friends.filter((f) => f.state === 'pending_in' && !waiting.has(f.key));
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
  /** process.platform: macOS uses the system's notifications, everything else GhostLink's cards. */
  platform: string;
  /** "Mostrar notificações na área de trabalho" (Configurações > Notificações). */
  enabled(): boolean;
  locale(): Locale;
  /** The system's notifications (macOS). */
  isSupported(): boolean;
  create(options: { title: string; body: string; silent: boolean }): NativeNotification;
  /** GhostLink's own cards (toasts.ts). */
  toasts: { show(toast: ToastInput): boolean };
  window(): NotifierWindow | null;
  openChannel(event: OpenChannelEvent): void;
  /** A direct message's notification was clicked: show that conversation. */
  openConversation(conv: string): void;
  /** A friend request's notification was clicked: Home > Amigos > Pendentes. */
  openFriendRequests(): void;
}

/** One notification, whichever way it shows: a card (picture, title, "Autor: texto") or the system's. */
interface Note {
  icon: ToastIcon;
  title: string;
  author: string | null;
  body: string;
  /** After the window came back: what the notification is about. */
  open(): void;
}

function initialsOf(name: string): ToastIcon {
  return { kind: 'initials', text: serverInitials(name) };
}

/**
 * Desktop notifications (spec 2026-10-02-notificacoes-design.md): channel messages (the renderer
 * applies each server's mode), direct messages from friends (the friends engine decides which),
 * new friend requests, and the app's own notices. On Windows and Linux they are GhostLink's cards
 * (toasts.ts), without sound; macOS keeps the system's. Messages and requests show only while the
 * window is not focused and the setting is on; a click brings the window back on what it is about.
 */
export class ChatNotifier {
  /** System notifications kept alive until closed (a collected Notification loses its click handler), newest last, bounded. */
  readonly #live = new Set<NativeNotification>();
  /** The last friends snapshot, to tell a new request from one already waiting. */
  #friends: FriendsSnapshot | null = null;

  constructor(private readonly deps: NotifierDeps) {}

  /** A message in a channel of the server on screen: "Servidor ➜ #canal", "Autor: texto", the server's icon. */
  show(n: ChatNotification): boolean {
    const icon: ToastIcon =
      n.serverIcon === null ? initialsOf(n.server) : { kind: 'image', url: avatarUrl(n.serverIcon), fallback: serverInitials(n.server) };
    return this.#notify({ icon, title: `${n.server} ➜ #${n.channel}`, author: n.author, body: n.body, open: () => this.deps.openChannel({ channelId: n.channelId }) });
  }

  /** A message from a friend: their name and the text. Never logged. */
  showDm(n: DmNotification): boolean {
    return this.#notify({ icon: initialsOf(n.title), title: n.title, author: null, body: n.body, open: () => this.deps.openConversation(n.conv) });
  }

  /** Every friends snapshot: each request that was not waiting before gets a card. */
  friendsChanged(snapshot: FriendsSnapshot): void {
    const fresh = newFriendRequests(this.#friends, snapshot);
    this.#friends = snapshot;
    for (const friend of fresh) this.#friendRequest(friend);
  }

  /** The app's own notice (the tray's "continua rodando"): the ghost, whatever the focus and the setting. */
  showNotice(text: string): boolean {
    return this.#deliver({ icon: { kind: 'ghost' }, title: APP_NAME, author: null, body: text, open: () => {} });
  }

  get pending(): number {
    return this.#live.size;
  }

  #friendRequest(friend: Friend): boolean {
    const locale = this.deps.locale();
    const name = friend.localName ?? (friend.nickname !== '' ? friend.nickname : formatShortCode(friend.shortCode));
    return this.#notify({
      icon: initialsOf(name),
      title: notificationsText(locale, 'notifications.friendRequest.title'),
      author: null,
      body: notificationsText(locale, 'notifications.friendRequest.body', { name }),
      open: () => this.deps.openFriendRequests(),
    });
  }

  /** Messages, direct messages and requests: only while the window is not focused and the setting is on. */
  #notify(note: Note): boolean {
    const win = this.deps.window();
    if (!win || win.isDestroyed() || win.isFocused() || !this.deps.enabled()) return false;
    return this.#deliver(note);
  }

  #deliver(note: Note): boolean {
    const open = () => {
      const w = this.deps.window();
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      note.open();
    };
    if (usesOwnCards(this.deps.platform)) {
      return this.deps.toasts.show({ icon: note.icon, title: note.title, author: note.author, body: note.body, onClick: open });
    }
    return this.#native(note.title, note.author === null ? note.body : `${note.author}: ${note.body}`, open);
  }

  /** macOS: the system's notification, silent like the cards. */
  #native(rawTitle: string, rawBody: string, open: () => void): boolean {
    if (!this.deps.isSupported()) return false;
    const title = notificationText(rawTitle, TITLE_MAX);
    const body = notificationText(rawBody, BODY_MAX);
    if (title === '') return false;
    const note = this.deps.create({ title, body, silent: true });
    this.#live.add(note);
    while (this.#live.size > MAX_LIVE_NOTIFICATIONS) this.#live.delete(this.#live.values().next().value!);
    note.on('click', () => {
      this.#live.delete(note);
      open();
    });
    note.on('close', () => this.#live.delete(note));
    note.on('failed', () => this.#live.delete(note));
    note.show();
    return true;
  }
}
