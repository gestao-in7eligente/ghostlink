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

describe('sendMessage with files (anexos §1)', () => {
  type Upload = { uploadId: string; serverId: string; channelId: string; name: string; bytes: number[] };
  let uploads: Upload[];
  let failNext: string | null;
  let listeners: Array<(e: { uploadId: string; sent: number; total: number }) => void>;

  beforeEach(() => {
    uploads = [];
    failNext = null;
    listeners = [];
    const ghostlink = (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink;
    ghostlink.attachments = {
      upload: vi.fn(async (uploadId: string, serverId: string, channelId: string, name: string, bytes: Uint8Array) => {
        uploads.push({ uploadId, serverId, channelId, name, bytes: [...bytes] });
        for (const l of listeners) l({ uploadId, sent: 1, total: 2 });
        if (failNext) {
          const code = failNext;
          failNext = null;
          throw new Error(code);
        }
        return { fileId: `F${uploads.length}`.padEnd(26, 'A') };
      }),
      save: vi.fn(),
      onProgress: (cb: (e: { uploadId: string; sent: number; total: number }) => void) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((l) => l !== cb);
        };
      },
    } as unknown as GhostlinkApi['attachments'];
  });

  const file = (id: string, name: string, bytes: number[]) => ({ id, name, size: bytes.length, kind: 'file' as const, file: new Blob([new Uint8Array(bytes)]) });

  it('uploads each file to the server on screen, then sends the message naming them (the text may be empty)', async () => {
    handler = (_t, p) => ({ message: message(13, { authorId: ME, content: '', clientMsgId: (p as { clientMsgId: string }).clientMsgId }) });
    await sendMessage(GERAL, '', null, [file('a', 'a.pdf', [1, 2]), file('b', 'b.png', [3])]);
    expect(uploads.map((u) => [u.serverId, u.channelId, u.name, u.bytes])).toEqual([
      ['srv-1', GERAL, 'a.pdf', [1, 2]],
      ['srv-1', GERAL, 'b.png', [3]],
    ]);
    const [type, payload] = calls.at(-1)!;
    expect(type).toBe('msg.send');
    expect(payload).toMatchObject({ channelId: GERAL, content: '', attachmentIds: ['F1'.padEnd(26, 'A'), 'F2'.padEnd(26, 'A')] });
    expect(listeners).toEqual([]); // every progress subscription was dropped
    expect(log()!.pending).toEqual([]);
  });

  it('keeps per-file progress, and a retry sends again only what did not get through', async () => {
    failNext = null;
    let sends = 0;
    handler = (_t, p) => {
      sends++;
      return { message: message(14, { authorId: ME, clientMsgId: (p as { clientMsgId: string }).clientMsgId }) };
    };
    // The second file is refused: the message stays, the first file keeps its id.
    const api = (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink.attachments;
    const upload = api.upload as ReturnType<typeof vi.fn>;
    const real = upload.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    upload.mockImplementationOnce(real).mockImplementationOnce(async (...args: unknown[]) => {
      failNext = 'QUOTA_EXCEEDED';
      return real(...args);
    });
    await sendMessage(GERAL, 'fotos', null, [file('a', 'a.png', [1]), file('b', 'b.png', [2])]);
    const [pending] = log()!.pending;
    expect(pending).toMatchObject({ error: 'QUOTA_EXCEEDED' });
    expect(pending!.files!.map((f) => [f.id, f.fileId, f.progress])).toEqual([
      ['a', 'F1'.padEnd(26, 'A'), 1],
      ['b', null, 0.5],
    ]);
    expect(sends).toBe(0);

    await retryMessage(GERAL, pending!.clientMsgId);
    expect(uploads.map((u) => u.name)).toEqual(['a.png', 'b.png', 'b.png']);
    expect(calls.at(-1)![1]).toMatchObject({ attachmentIds: ['F1'.padEnd(26, 'A'), 'F3'.padEnd(26, 'A')] });
    expect(log()!.pending).toEqual([]);
  });

  it('uploads every file again after BAD_ATTACHMENT (an unused upload expires)', async () => {
    handler = () => {
      throw new Error('BAD_ATTACHMENT');
    };
    await sendMessage(GERAL, 'oi', null, [file('a', 'a.png', [1])]);
    const [pending] = log()!.pending;
    expect(pending).toMatchObject({ error: 'BAD_ATTACHMENT' });
    handler = (_t, p) => ({ message: message(15, { authorId: ME, clientMsgId: (p as { clientMsgId: string }).clientMsgId }) });
    await retryMessage(GERAL, pending!.clientMsgId);
    expect(uploads.map((u) => u.name)).toEqual(['a.png', 'a.png']);
    expect(calls.at(-1)![1]).toMatchObject({ attachmentIds: ['F2'.padEnd(26, 'A')] });
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
