import { describe, expect, it, vi } from 'vitest';
import { ChatNotifier, MAX_LIVE_NOTIFICATIONS, notificationText, type NativeNotification, type NotifierWindow } from '../../src/main/notifications.js';

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

function setup(focused: boolean) {
  const win = fakeWindow(focused);
  const created: Array<{ options: unknown; handlers: Map<string, () => void>; show: ReturnType<typeof vi.fn> }> = [];
  const openChannel = vi.fn();
  const openConversation = vi.fn();
  const notifier = new ChatNotifier({
    isSupported: () => true,
    create: (options) => {
      const handlers = new Map<string, () => void>();
      const note = { options, handlers, show: vi.fn() };
      created.push(note);
      return { on: (e: string, l: () => void) => handlers.set(e, l), show: note.show } as NativeNotification;
    },
    window: () => win,
    openChannel,
    openConversation,
  });
  return { win, created, openChannel, openConversation, notifier };
}

const N = { title: 'Ana mencionou você em #geral', body: 'oi @Bia', channelId: 'A'.repeat(26) };

describe('ChatNotifier (spec §11.1 item 8)', () => {
  it('stays quiet while the window is focused', () => {
    const { notifier, created } = setup(true);
    expect(notifier.show(N)).toBe(false);
    expect(created).toEqual([]);
  });

  it('shows a notification when unfocused; a click restores the window and opens the channel', () => {
    const { notifier, created, win, openChannel } = setup(false);
    expect(notifier.show(N)).toBe(true);
    expect(created[0]!.options).toEqual({ title: N.title, body: N.body, silent: false });
    expect(created[0]!.show).toHaveBeenCalledOnce();
    expect(notifier.pending).toBe(1);
    created[0]!.handlers.get('click')!();
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(openChannel).toHaveBeenCalledWith({ channelId: N.channelId });
    expect(notifier.pending).toBe(0);
  });

  it('keeps only the newest notifications alive (Windows may never send close for old toasts)', () => {
    const { notifier, created } = setup(false);
    for (let i = 0; i < MAX_LIVE_NOTIFICATIONS + 5; i += 1) notifier.show(N);
    expect(notifier.pending).toBe(MAX_LIVE_NOTIFICATIONS);
    created.at(-1)!.handlers.get('failed')!();
    expect(notifier.pending).toBe(MAX_LIVE_NOTIFICATIONS - 1);
  });

  it('flattens control characters and bounds the length', () => {
    expect(notificationText('a\nb‮\u0000c', 64)).toBe('a b c');
    expect(notificationText('x'.repeat(300), 200)).toHaveLength(200);
    const { notifier, created } = setup(false);
    notifier.show({ ...N, body: 'x'.repeat(5000) });
    expect((created[0]!.options as { body: string }).body.length).toBeLessThanOrEqual(200);
    expect(notifier.show({ ...N, title: '​' })).toBe(false);
  });
});

describe('ChatNotifier: direct messages (friends spec §8)', () => {
  const DM = { conv: 'c0'.repeat(16), title: 'Bia', body: 'oi, tudo bem?' };

  it('follows the same rule: quiet while the window is focused', () => {
    const { notifier, created } = setup(true);
    expect(notifier.showDm(DM)).toBe(false);
    expect(created).toEqual([]);
  });

  it("shows the friend's name and the text; a click restores the window and opens the conversation", () => {
    const { notifier, created, win, openChannel, openConversation } = setup(false);
    expect(notifier.showDm(DM)).toBe(true);
    expect(created[0]!.options).toEqual({ title: 'Bia', body: 'oi, tudo bem?', silent: false });
    created[0]!.handlers.get('click')!();
    expect(win.focus).toHaveBeenCalled();
    expect(openConversation).toHaveBeenCalledWith(DM.conv);
    expect(openChannel).not.toHaveBeenCalled();
    expect(notifier.pending).toBe(0);
  });

  it('cleans and bounds the text like any other notification', () => {
    const { notifier, created } = setup(false);
    notifier.showDm({ ...DM, title: 'Bia‮', body: `linha 1\nlinha 2${'x'.repeat(5000)}` });
    const options = created[0]!.options as { title: string; body: string };
    expect(options.title).toBe('Bia');
    expect(options.body.startsWith('linha 1 linha 2')).toBe(true);
    expect(options.body.length).toBeLessThanOrEqual(200);
  });
});
