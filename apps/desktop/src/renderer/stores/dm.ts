// Direct messages as the Home screen shows them (friends spec 2026-09-30 §8). Main owns the
// conversations and the log; this keeps the sidebar list, the loaded pages of each open
// conversation, "digitando…" and the drafts, and applies what main pushes.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AppErrorCode } from '../../shared/appErrors.js';
import { DM_PAGE, type DmApi, type DmConversation, type DmEvent, type DmMessage } from '../../shared/dmTypes.js';
import { applyConversation, applyMessage, mergeHistory } from '../features/dm/dmModel.js';
import { errorCodeOf } from '../i18n/index.js';

export interface DmLog {
  /** Loaded messages, oldest first. */
  messages: DmMessage[];
  status: 'loading' | 'ready' | 'error';
  /** Older messages exist beyond the first loaded one. */
  hasMore: boolean;
  older: 'idle' | 'loading' | 'error';
}

interface DmStore {
  conversations: DmConversation[];
  loadError: AppErrorCode | null;
  /** The conversation in the center; null shows the Friends page. */
  selected: string | null;
  logs: Record<string, DmLog>;
  /** conv → author → when the last typing signal arrived (ms). */
  typing: Record<string, Record<string, number>>;
  drafts: Record<string, string>;
  apply(event: DmEvent): void;
  /** The sidebar list. Forgets the loaded pages: events may have been missed meanwhile. */
  load(): Promise<void>;
  /** "Mensagem" on a friend: the conversation with them, shown in the center. */
  open(friendKey: string): Promise<void>;
  select(conv: string | null): void;
  /** "×" in the sidebar: closes the conversation without deleting it. */
  hide(conv: string): Promise<void>;
  /** The newest page, or with `older` the page before the first loaded message. */
  loadHistory(conv: string, older?: boolean): Promise<void>;
  setDraft(conv: string, text: string): void;
}

/** window.ghostlink.dm, reached through globalThis so the store's tests typecheck without the DOM types. */
const dmApi = (): DmApi => (globalThis as unknown as { window: { ghostlink: { dm: DmApi } } }).window.ghostlink.dm;

const fresh = (): DmLog => ({ messages: [], status: 'loading', hasMore: true, older: 'idle' });

export const useDmStore = create<DmStore>()((set, get) => {
  const patchLog = (conv: string, patch: (log: DmLog) => Partial<DmLog>) => {
    const log = get().logs[conv];
    if (log) set({ logs: { ...get().logs, [conv]: { ...log, ...patch(log) } } });
  };

  return {
    conversations: [],
    loadError: null,
    selected: null,
    logs: {},
    typing: {},
    drafts: {},

    apply: (event) => {
      if (event.type === 'conversation') {
        set({ conversations: applyConversation(get().conversations, event.conversation) });
        return;
      }
      if (event.type === 'typing') {
        const forConv = get().typing[event.conv] ?? {};
        set({ typing: { ...get().typing, [event.conv]: { ...forConv, [event.author]: Date.now() } } });
        return;
      }
      const { message } = event;
      // A message ends its author's "digitando…".
      const forConv = get().typing[message.conv];
      if (forConv && Object.hasOwn(forConv, message.author)) {
        const { [message.author]: _gone, ...rest } = forConv;
        set({ typing: { ...get().typing, [message.conv]: rest } });
      }
      // A conversation that is not loaded fetches its messages when it opens.
      patchLog(message.conv, (log) => ({ messages: applyMessage(log.messages, message) }));
    },

    load: async () => {
      set({ logs: {} });
      try {
        set({ conversations: await dmApi().conversations(), loadError: null });
      } catch (e) {
        set({ loadError: errorCodeOf(e) });
      }
      const selected = get().selected;
      if (selected !== null) {
        if (get().conversations.some((c) => c.id === selected)) void get().loadHistory(selected);
        else set({ selected: null });
      }
    },

    open: async (friendKey) => {
      const conversation = await dmApi().open(friendKey);
      set({ conversations: applyConversation(get().conversations, conversation) });
      get().select(conversation.id);
    },

    select: (conv) => {
      set({ selected: conv });
      if (conv === null) return;
      const log = get().logs[conv];
      if (!log || log.status === 'error') void get().loadHistory(conv);
    },

    hide: async (conv) => {
      await dmApi().hide(conv);
      set({
        conversations: get().conversations.map((c) => (c.id === conv ? { ...c, hidden: true } : c)),
        selected: get().selected === conv ? null : get().selected,
      });
    },

    loadHistory: async (conv, older = false) => {
      const log = get().logs[conv];
      if (older) {
        if (!log || log.status !== 'ready' || !log.hasMore || log.older === 'loading') return;
        patchLog(conv, () => ({ older: 'loading' }));
        try {
          const page = await dmApi().history(conv, log.messages[0]?.ts ?? null, DM_PAGE);
          // A page never splits messages with the same time, so it may hold more than DM_PAGE.
          patchLog(conv, (now) => ({ messages: mergeHistory(now.messages, page), hasMore: page.length >= DM_PAGE, older: 'idle' }));
        } catch {
          patchLog(conv, () => ({ older: 'error' }));
        }
        return;
      }
      if (log?.status === 'loading') return;
      set({ logs: { ...get().logs, [conv]: log ? { ...log, status: 'loading' } : fresh() } });
      try {
        const page = await dmApi().history(conv, null, DM_PAGE);
        // Messages that arrived while the page was on its way are kept.
        patchLog(conv, (now) => ({ messages: mergeHistory(now.messages, page), status: 'ready', hasMore: page.length >= DM_PAGE, older: 'idle' }));
      } catch {
        patchLog(conv, () => ({ status: 'error' }));
      }
    },

    setDraft: (conv, text) => {
      if ((get().drafts[conv] ?? '') !== text) set({ drafts: { ...get().drafts, [conv]: text } });
    },
  };
});

/** Applies a message main returned (send, edit, delete) the same way as one it pushed. */
export function applyOwn(message: DmMessage): void {
  useDmStore.getState().apply({ type: 'message', message });
}

/** Keeps the store in step with main while the Home screen is mounted. */
export function useDmSync(): void {
  useEffect(() => {
    const off = dmApi().onEvent((event) => useDmStore.getState().apply(event));
    void useDmStore.getState().load();
    return off;
  }, []);
}
