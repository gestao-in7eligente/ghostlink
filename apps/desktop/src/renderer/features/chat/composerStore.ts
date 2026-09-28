// What the composer is doing: replying to or editing a message, and the unsent
// draft of each channel (kept in memory only, per the session).
import { create } from 'zustand';
import type { MentionCandidate } from './mentions.js';

export interface ComposerTarget {
  channelId: string;
  messageId: number;
}

interface ComposerState {
  reply: ComposerTarget | null;
  edit: ComposerTarget | null;
  drafts: Readonly<Record<string, string>>;
  /** A mention to insert into the open composer (the member menu's "Mencionar"). */
  mention: MentionCandidate | null;
  startReply(target: ComposerTarget): void;
  startEdit(target: ComposerTarget): void;
  cancel(): void;
  setDraft(channelId: string, text: string): void;
  requestMention(candidate: MentionCandidate | null): void;
}

export const useComposerStore = create<ComposerState>()((set) => ({
  reply: null,
  edit: null,
  drafts: {},
  mention: null,
  startReply: (reply) => set({ reply, edit: null }),
  startEdit: (edit) => set({ edit, reply: null }),
  cancel: () => set({ reply: null, edit: null }),
  setDraft: (channelId, text) =>
    set((s) => {
      const drafts = { ...s.drafts };
      if (text === '') delete drafts[channelId];
      else drafts[channelId] = text;
      return { drafts };
    }),
  requestMention: (mention) => set({ mention }),
}));
