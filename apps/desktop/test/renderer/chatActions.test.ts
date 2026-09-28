import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostlinkApi } from '../../src/shared/ipcTypes.js';
import { loadHistory, markRead, request, retryMessage, sendMessage, sendTyping } from '../../src/renderer/features/chat/actions.js';
import { initialText, useTextStore } from '../../src/renderer/stores/text.js';
import { GERAL, ME, message, snapshot } from './textFixtures.js';
import { z } from 'zod';

type Handler = (type: string, payload: unknown) => unknown;
let handler: Handler;
const calls: [string, unknown][] = [];

function install() {
  const api = {
    server: {
      request: vi.fn(async (type: string, payload?: unknown) => {
        calls.push([type, payload]);
        return handler(type, payload);
      }),
    },
  } as unknown as GhostlinkApi;
  (globalThis as { window?: unknown }).window = { ghostlink: api };
}

beforeEach(() => {
  calls.length = 0;
  handler = () => ({});
  install();
  useTextStore.setState(initialText);
  useTextStore.getState().dispatch({ type: 'reset', snapshot: snapshot() });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const log = () => useTextStore.getState().messages.logs[GERAL];

describe('request', () => {
  it('validates the answer and turns a malformed one into INTERNAL', async () => {
    handler = () => ({ ok: 1 });
    await expect(request('x.y', {}, z.object({ ok: z.number() }))).resolves.toEqual({ ok: 1 });
    handler = () => ({ ok: 'no' });
    await expect(request('x.y', {}, z.object({ ok: z.number() }))).rejects.toThrow('INTERNAL');
  });
});

describe('loadHistory', () => {
  it('loads the newest page, then older pages before the oldest message', async () => {
    handler = (_t, p) => {
      const before = (p as { before?: number }).before;
      return before === undefined ? { messages: [message(9), message(10)], hasMore: true } : { messages: [message(7)], hasMore: false };
    };
    await loadHistory(GERAL);
    expect(log()!.items.map((m) => m.id)).toEqual([9, 10]);
    await loadHistory(GERAL, true);
    expect(calls.at(-1)).toEqual(['msg.history', { channelId: GERAL, limit: 50, before: 9 }]);
    expect(log()!.items.map((m) => m.id)).toEqual([7, 9, 10]);
    await loadHistory(GERAL, true); // nothing more to load
    expect(calls).toHaveLength(2);
  });

  it('drops messages of another channel smuggled into the page', async () => {
    handler = () => ({ messages: [message(9, { channelId: 'Z'.repeat(26) }), message(10)], hasMore: false });
    await loadHistory(GERAL);
    expect(log()!.items.map((m) => m.id)).toEqual([10]);
  });

  it('ignores a late page after another server welcome', async () => {
    let answer!: (v: unknown) => void;
    handler = () => new Promise((resolve) => (answer = resolve));
    const pending = loadHistory(GERAL);
    await Promise.resolve();
    useTextStore.getState().dispatch({ type: 'reset', snapshot: snapshot({}, 'srv-2') });
    answer({ messages: [message(10)], hasMore: false });
    await pending;
    expect(log()).toBeUndefined();
  });

  it('marks a failed load', async () => {
    handler = () => {
      throw new Error('NOT_FOUND');
    };
    await loadHistory(GERAL);
    expect(log()!.status).toBe('error');
  });
});

describe('sendMessage', () => {
  it('shows the message as pending, then replaces it with the server copy', async () => {
    let clientMsgId = '';
    handler = (_t, p) => {
      const payload = p as { clientMsgId: string; content: string; channelId: string };
      clientMsgId = payload.clientMsgId;
      expect(log()!.pending).toHaveLength(1);
      return { message: message(11, { authorId: ME, content: payload.content, clientMsgId }) };
    };
    await sendMessage(GERAL, 'oi', 10);
    expect(clientMsgId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(calls[0]).toEqual(['msg.send', { channelId: GERAL, content: 'oi', clientMsgId, replyTo: 10 }]);
    expect(log()!.pending).toEqual([]);
    expect(log()!.items.map((m) => m.id)).toEqual([11]);
  });

  it('keeps a failed message with its error, and a retry reuses the clientMsgId', async () => {
    handler = () => {
      throw new Error('RATE_LIMITED');
    };
    await sendMessage(GERAL, 'oi', null);
    const [pending] = log()!.pending;
    expect(pending).toMatchObject({ content: 'oi', error: 'RATE_LIMITED' });
    handler = (_t, p) => ({ message: message(12, { authorId: ME, clientMsgId: (p as { clientMsgId: string }).clientMsgId }) });
    await retryMessage(GERAL, pending!.clientMsgId);
    expect((calls.at(-1)![1] as { clientMsgId: string }).clientMsgId).toBe(pending!.clientMsgId);
    expect(log()!.pending).toEqual([]);
  });
});

describe('read marks and typing', () => {
  it('marks read at once and applies the server answer', async () => {
    handler = () => ({ readState: { channelId: GERAL, lastReadMessageId: 12, mentionCount: 0 } });
    await markRead(GERAL, 12);
    expect(calls).toEqual([['channel.read', { channelId: GERAL, messageId: 12 }]]);
    expect(useTextStore.getState().channels.reads[GERAL]).toEqual({ lastReadMessageId: 12, mentionCount: 0 });
  });

  it('sends typing at most once every 3 seconds per channel', () => {
    sendTyping(GERAL, 1_000);
    sendTyping(GERAL, 2_000);
    sendTyping(GERAL, 4_100);
    expect(calls.filter(([type]) => type === 'typing')).toHaveLength(2);
  });
});
