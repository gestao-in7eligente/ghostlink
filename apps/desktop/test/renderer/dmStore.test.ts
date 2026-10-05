import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DM_PAGE, type DmConversation, type DmMessage } from '../../src/shared/dmTypes.js';
import { useDmStore } from '../../src/renderer/stores/dm.js';

const CONV = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const PEER = 'P'.repeat(43);

function conversation(patch: Partial<DmConversation> = {}): DmConversation {
  return { id: CONV, kind: 'dm', peer: PEER, lastTs: null, lastText: null, unread: 0, hidden: false, ...patch };
}

function message(n: number, patch: Partial<DmMessage> = {}): DmMessage {
  return { id: n.toString(16).padStart(32, '0'), conv: CONV, author: PEER, mine: false, ts: 1_000 * n, text: `m${n}`, replyTo: null, editedAt: null, deleted: false, delivered: true, attachments: [], ...patch };
}

const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => message(from + i));

function fakeDm() {
  return {
    conversations: vi.fn(async () => [conversation()]),
    open: vi.fn(async () => conversation()),
    hide: vi.fn(async () => undefined),
    history: vi.fn(async (_conv: string, _before: number | null, _limit: number): Promise<DmMessage[]> => page(1, 3)),
    send: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
    read: vi.fn(async () => undefined),
    typing: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
}

let dm: ReturnType<typeof fakeDm>;
const initial = useDmStore.getState();

beforeEach(() => {
  dm = fakeDm();
  vi.stubGlobal('window', { ghostlink: { dm } });
  useDmStore.setState({ ...initial, conversations: [], logs: {}, typing: {}, drafts: {}, selected: null, loadError: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the direct-message store', () => {
  it('opens a friend: the conversation goes in, is selected and its newest page loads', async () => {
    await useDmStore.getState().open(PEER);
    await settle();
    const s = useDmStore.getState();
    expect(dm.open).toHaveBeenCalledWith(PEER);
    expect(s.selected).toBe(CONV);
    expect(s.conversations).toEqual([conversation()]);
    expect(dm.history).toHaveBeenCalledWith(CONV, null, DM_PAGE);
    expect(s.logs[CONV]).toMatchObject({ status: 'ready', hasMore: false, older: 'idle' });
    expect(s.logs[CONV]!.messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);
  });

  it('pages back from the oldest loaded message and stops when a page comes back short', async () => {
    dm.history.mockResolvedValueOnce(page(60, DM_PAGE)).mockResolvedValueOnce(page(55, 5));
    useDmStore.getState().select(CONV);
    await settle();
    expect(useDmStore.getState().logs[CONV]!.hasMore).toBe(true);
    await useDmStore.getState().loadHistory(CONV, true);
    expect(dm.history).toHaveBeenLastCalledWith(CONV, 60_000, DM_PAGE);
    const log = useDmStore.getState().logs[CONV]!;
    expect(log.messages).toHaveLength(DM_PAGE + 5);
    expect(log.messages[0]!.text).toBe('m55');
    expect(log.hasMore).toBe(false);
    // Nothing more to ask for.
    await useDmStore.getState().loadHistory(CONV, true);
    expect(dm.history).toHaveBeenCalledTimes(2);
  });

  it('keeps paging when a page holds more than DM_PAGE (same-time messages are never split)', async () => {
    dm.history.mockResolvedValueOnce(page(1, DM_PAGE + 3));
    useDmStore.getState().select(CONV);
    await settle();
    expect(useDmStore.getState().logs[CONV]!.hasMore).toBe(true);
  });

  it('applies pushed messages to a loaded conversation, by id, and ignores conversations not loaded', async () => {
    useDmStore.getState().select(CONV);
    await settle();
    const { apply } = useDmStore.getState();
    apply({ type: 'message', message: message(2, { text: 'edited', editedAt: 5 }) });
    apply({ type: 'message', message: message(9) });
    apply({ type: 'message', message: message(1, { conv: OTHER }) });
    const s = useDmStore.getState();
    expect(s.logs[CONV]!.messages.map((m) => m.text)).toEqual(['m1', 'edited', 'm3', 'm9']);
    expect(s.logs[OTHER]).toBeUndefined();
  });

  it('keeps a message that arrived while the first page was on its way', async () => {
    let resolve: (m: DmMessage[]) => void = () => undefined;
    dm.history.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    useDmStore.getState().select(CONV);
    useDmStore.getState().apply({ type: 'message', message: message(7) });
    resolve(page(1, 2));
    await settle();
    expect(useDmStore.getState().logs[CONV]!.messages.map((m) => m.text)).toEqual(['m1', 'm2', 'm7']);
  });

  it('shows "digitando…" until that person\'s message arrives', async () => {
    useDmStore.getState().select(CONV);
    await settle();
    useDmStore.getState().apply({ type: 'typing', conv: CONV, author: PEER });
    expect(useDmStore.getState().typing[CONV]?.[PEER]).toBeTypeOf('number');
    useDmStore.getState().apply({ type: 'message', message: message(4) });
    expect(useDmStore.getState().typing[CONV]?.[PEER]).toBeUndefined();
  });

  it('closes a conversation in the sidebar and goes back to the friends page when it was open', async () => {
    await useDmStore.getState().open(PEER);
    await useDmStore.getState().hide(CONV);
    const s = useDmStore.getState();
    expect(dm.hide).toHaveBeenCalledWith(CONV);
    expect(s.conversations[0]!.hidden).toBe(true);
    expect(s.selected).toBeNull();
  });

  it('a failed page shows the error, and selecting the conversation again retries', async () => {
    dm.history.mockRejectedValueOnce(new Error('P2P_UNAVAILABLE'));
    useDmStore.getState().select(CONV);
    await settle();
    expect(useDmStore.getState().logs[CONV]!.status).toBe('error');
    useDmStore.getState().select(CONV);
    await settle();
    expect(useDmStore.getState().logs[CONV]!.status).toBe('ready');
  });

  it('reloading forgets the loaded pages (events may have been missed) and reloads the open one', async () => {
    useDmStore.getState().select(CONV);
    await settle();
    useDmStore.setState({ logs: { ...useDmStore.getState().logs, [OTHER]: { messages: [], status: 'ready', hasMore: false, older: 'idle' } } });
    await useDmStore.getState().load();
    await settle();
    const s = useDmStore.getState();
    expect(Object.keys(s.logs)).toEqual([CONV]);
    expect(dm.history).toHaveBeenCalledTimes(2);
  });

  it('drops the selection when the conversation is gone after a reload', async () => {
    useDmStore.setState({ selected: OTHER });
    await useDmStore.getState().load();
    expect(useDmStore.getState().selected).toBeNull();
  });
});
