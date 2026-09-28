import { describe, expect, it, vi } from 'vitest';
import { ChatNotifier, notificationText, type NativeNotification, type NotifierWindow } from '../../src/main/notifications.js';

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
  });
  return { win, created, openChannel, notifier };
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

  it('flattens control characters and bounds the length', () => {
    expect(notificationText('a\nb‮\u0000c', 64)).toBe('a b c');
    expect(notificationText('x'.repeat(300), 200)).toHaveLength(200);
    const { notifier, created } = setup(false);
    notifier.show({ ...N, body: 'x'.repeat(5000) });
    expect((created[0]!.options as { body: string }).body.length).toBeLessThanOrEqual(200);
    expect(notifier.show({ ...N, title: '​' })).toBe(false);
  });
});
