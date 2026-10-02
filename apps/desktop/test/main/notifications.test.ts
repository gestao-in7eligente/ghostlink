import { describe, expect, it, vi } from 'vitest';
import type { Friend, FriendsSnapshot } from '../../src/shared/friendsTypes.js';
import {
  ChatNotifier,
  MAX_LIVE_NOTIFICATIONS,
  newFriendRequests,
  notificationText,
  type NativeNotification,
  type NotifierWindow,
} from '../../src/main/notifications.js';
import type { ToastInput } from '../../src/main/toasts.js';

function fakeWindow(focused: boolean) {
  return {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  } satisfies NotifierWindow;
}

function setup({ focused = false, platform = 'win32', enabled = true }: { focused?: boolean; platform?: string; enabled?: boolean } = {}) {
  const win = fakeWindow(focused);
  const created: Array<{ options: unknown; handlers: Map<string, () => void>; show: ReturnType<typeof vi.fn> }> = [];
  const cards: ToastInput[] = [];
  const setting = { enabled };
  const openChannel = vi.fn();
  const openConversation = vi.fn();
  const openFriendRequests = vi.fn();
  const notifier = new ChatNotifier({
    platform,
    enabled: () => setting.enabled,
    locale: () => 'pt-BR',
    isSupported: () => true,
    create: (options) => {
      const handlers = new Map<string, () => void>();
      const note = { options, handlers, show: vi.fn() };
      created.push(note);
      return { on: (e: string, l: () => void) => handlers.set(e, l), show: note.show } as NativeNotification;
    },
    toasts: {
      show: (card) => {
        cards.push(card);
        return true;
      },
    },
    window: () => win,
    openChannel,
    openConversation,
    openFriendRequests,
  });
  return { win, created, cards, setting, openChannel, openConversation, openFriendRequests, notifier };
}

const N = { server: 'Casa', channel: 'geral', author: 'Ana', body: 'oi @Bia', serverIcon: null, channelId: 'A'.repeat(26) };
const ICON = 'ab'.repeat(32);

describe('ChatNotifier: channel messages (notifications spec §1)', () => {
  it("shows GhostLink's card on Windows: the server's initials, \"Servidor ➜ #canal\", the author and the text", () => {
    const { notifier, cards, created } = setup();
    expect(notifier.show(N)).toBe(true);
    expect(created).toEqual([]); // never the system's toast there
    expect(cards).toEqual([{ icon: { kind: 'initials', text: 'C' }, title: 'Casa ➜ #geral', author: 'Ana', body: 'oi @Bia', onClick: expect.any(Function) }]);
    expect(setup({ platform: 'linux' }).notifier.show(N)).toBe(true);
  });

  it("shows the server's icon when it has one, with its initials for when the picture does not load", () => {
    const { notifier, cards } = setup();
    notifier.show({ ...N, server: 'Estação Monky', serverIcon: ICON });
    expect(cards[0]!.icon).toEqual({ kind: 'image', url: `app://ghostlink/_avatar/${ICON}`, fallback: 'EM' });
  });

  it('a click on the card restores the window and opens the channel', () => {
    const { notifier, cards, win, openChannel } = setup();
    notifier.show(N);
    cards[0]!.onClick();
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(openChannel).toHaveBeenCalledWith({ channelId: N.channelId });
  });

  it('stays quiet while the window is focused, and while the setting is off', () => {
    const focused = setup({ focused: true });
    expect(focused.notifier.show(N)).toBe(false);
    expect(focused.cards).toEqual([]);
    const off = setup({ enabled: false });
    expect(off.notifier.show(N)).toBe(false);
    expect(off.notifier.showDm({ conv: 'c0'.repeat(16), title: 'Bia', body: 'oi' })).toBe(false);
    expect(off.cards).toEqual([]);
    off.setting.enabled = true;
    expect(off.notifier.show(N)).toBe(true);
  });

  it("keeps the system's notification on macOS, silent, with \"Autor: texto\" as its text", () => {
    const { notifier, cards, created, win, openChannel } = setup({ platform: 'darwin' });
    expect(notifier.show(N)).toBe(true);
    expect(cards).toEqual([]);
    expect(created[0]!.options).toEqual({ title: 'Casa ➜ #geral', body: 'Ana: oi @Bia', silent: true });
    expect(created[0]!.show).toHaveBeenCalledOnce();
    expect(notifier.pending).toBe(1);
    created[0]!.handlers.get('click')!();
    expect(win.focus).toHaveBeenCalled();
    expect(openChannel).toHaveBeenCalledWith({ channelId: N.channelId });
    expect(notifier.pending).toBe(0);
  });

  it("keeps only the newest system notifications alive on macOS (the system may never send close)", () => {
    const { notifier, created } = setup({ platform: 'darwin' });
    for (let i = 0; i < MAX_LIVE_NOTIFICATIONS + 5; i += 1) notifier.show(N);
    expect(notifier.pending).toBe(MAX_LIVE_NOTIFICATIONS);
    created.at(-1)!.handlers.get('failed')!();
    expect(notifier.pending).toBe(MAX_LIVE_NOTIFICATIONS - 1);
  });

  it('flattens control characters and bounds the length of the system notification', () => {
    expect(notificationText('a\nb‮\u0000c', 64)).toBe('a b c');
    expect(notificationText('x'.repeat(300), 200)).toHaveLength(200);
    const { notifier, created } = setup({ platform: 'darwin' });
    notifier.show({ ...N, body: 'x'.repeat(5000) });
    expect((created[0]!.options as { body: string }).body.length).toBeLessThanOrEqual(200);
  });
});

describe('ChatNotifier: direct messages (friends spec §8)', () => {
  const DM = { conv: 'c0'.repeat(16), title: 'Bia Souza', body: 'oi, tudo bem?' };

  it("shows the friend's initials and name, and the text without an author; a click opens the conversation", () => {
    const { notifier, cards, win, openChannel, openConversation } = setup();
    expect(notifier.showDm(DM)).toBe(true);
    expect(cards[0]).toMatchObject({ icon: { kind: 'initials', text: 'BS' }, title: 'Bia Souza', author: null, body: 'oi, tudo bem?' });
    cards[0]!.onClick();
    expect(win.focus).toHaveBeenCalled();
    expect(openConversation).toHaveBeenCalledWith(DM.conv);
    expect(openChannel).not.toHaveBeenCalled();
  });

  it('follows the same rule: quiet while the window is focused', () => {
    const { notifier, cards } = setup({ focused: true });
    expect(notifier.showDm(DM)).toBe(false);
    expect(cards).toEqual([]);
  });
});

function friend(key: string, state: Friend['state'], extra: Partial<Friend> = {}): Friend {
  return { key, shortCode: 'ABCDEFGH', nickname: '', localName: null, state, online: false, since: 1, ...extra };
}

function snapshot(friends: Friend[], code: string | null = 'GLF1-ME'): FriendsSnapshot {
  return { revision: 1, running: true, available: true, code, inboxEnabled: true, friends };
}

describe('friend requests (notifications spec §1)', () => {
  it('only a request that was not waiting before is new; the first snapshot and another identity only note them', () => {
    const waiting = snapshot([friend('k1', 'pending_in'), friend('k2', 'friend')]);
    expect(newFriendRequests(null, waiting)).toEqual([]);
    expect(newFriendRequests(waiting, waiting)).toEqual([]);
    const more = snapshot([friend('k1', 'pending_in'), friend('k2', 'friend'), friend('k3', 'pending_in'), friend('k4', 'pending_out')]);
    expect(newFriendRequests(waiting, more).map((f) => f.key)).toEqual(['k3']);
    expect(newFriendRequests(waiting, snapshot(more.friends, 'GLF1-SOMEONE-ELSE'))).toEqual([]);
  });

  it('a new request shows "Pedido de amizade"; a click opens Amigos > Pendentes', () => {
    const { notifier, cards, openFriendRequests } = setup();
    notifier.friendsChanged(snapshot([]));
    notifier.friendsChanged(snapshot([friend('k1', 'pending_in', { nickname: 'Bia' })]));
    notifier.friendsChanged(snapshot([friend('k1', 'pending_in', { nickname: 'Bia' }), friend('k2', 'pending_in')]));
    expect(cards.map((c) => [c.icon, c.title, c.author, c.body])).toEqual([
      [{ kind: 'initials', text: 'B' }, 'Pedido de amizade', null, 'Bia quer ser seu amigo.'],
      [{ kind: 'initials', text: 'A' }, 'Pedido de amizade', null, 'ABCD-EFGH quer ser seu amigo.'],
    ]);
    cards[0]!.onClick();
    expect(openFriendRequests).toHaveBeenCalledOnce();
  });

  it('follows the focus rule and the setting, and still notes the request meanwhile', () => {
    const { notifier, cards, setting } = setup({ enabled: false });
    notifier.friendsChanged(snapshot([]));
    notifier.friendsChanged(snapshot([friend('k1', 'pending_in')]));
    setting.enabled = true;
    notifier.friendsChanged(snapshot([friend('k1', 'pending_in')]));
    expect(cards).toEqual([]);
  });
});

describe("ChatNotifier: the app's own notices (the tray's)", () => {
  it('shows the ghost and "GhostLink" whatever the setting and the focus; a click opens the window', () => {
    const { notifier, cards, win } = setup({ focused: true, enabled: false });
    expect(notifier.showNotice('O GhostLink continua rodando na bandeja.')).toBe(true);
    expect(cards[0]).toMatchObject({ icon: { kind: 'ghost' }, title: 'GhostLink', author: null, body: 'O GhostLink continua rodando na bandeja.' });
    cards[0]!.onClick();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it("is the system's notification on macOS", () => {
    const { notifier, created } = setup({ platform: 'darwin' });
    notifier.showNotice('O GhostLink continua rodando na bandeja.');
    expect(created[0]!.options).toEqual({ title: 'GhostLink', body: 'O GhostLink continua rodando na bandeja.', silent: true });
  });
});
