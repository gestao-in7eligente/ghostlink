// The text stores (server, channels, messages, members, bots) behind one dispatch:
// every slice reducer sees the same previous state, so cross-slice rules (mention
// counts need the current user's roles and the loaded messages) stay pure.
import { create } from 'zustand';
import { botsSlice, initialBots } from './bots.js';
import { channelsSlice, initialChannels } from './channels.js';
import { initialMembers, membersSlice } from './members.js';
import { initialMessages, messagesSlice } from './messages.js';
import { initialServer, serverSlice } from './server.js';
import type { TextAction, TextState } from './textState.js';

export type { TextAction, TextState } from './textState.js';

export const initialText: TextState = {
  server: initialServer,
  channels: initialChannels,
  messages: initialMessages,
  members: initialMembers,
  bots: initialBots,
};

/** Pure reducer of the whole text state. Unchanged slices keep their identity. */
export function textReducer(s: TextState, a: TextAction): TextState {
  const server = serverSlice(s.server, a);
  const channels = channelsSlice(s.channels, a, s);
  const messages = messagesSlice(s.messages, a, s);
  const members = membersSlice(s.members, a);
  const bots = botsSlice(s.bots, a, s);
  if (server === s.server && channels === s.channels && messages === s.messages && members === s.members && bots === s.bots) return s;
  return { server, channels, messages, members, bots };
}

interface TextStore extends TextState {
  dispatch(action: TextAction): void;
}

export const useTextStore = create<TextStore>()((set) => ({
  ...initialText,
  dispatch: (action) => set((s) => textReducer(s, action)),
}));

export function dispatchText(action: TextAction): void {
  useTextStore.getState().dispatch(action);
}

export function textState(): TextState {
  return useTextStore.getState();
}
