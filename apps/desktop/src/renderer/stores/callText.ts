// The call's server while the screen shows another one, or the Home screen (spec
// 2026-10-01-chamada-continua-design.md §2): its text state, as it was on screen and then kept
// live by the call connection's events (integration/callServer.ts). The voice UI reads its
// names, photos and channels; coming back to that server restores it at once, with no new
// welcome and nothing missed.
import { create } from 'zustand';
import type { TextState } from './textState.js';

export const useCallTextStore = create<{ text: TextState | null }>()(() => ({ text: null }));

/** The kept state of `serverId`, handed over once (the screen is back on it); null otherwise. */
export function takeCallText(serverId: string): TextState | null {
  const { text } = useCallTextStore.getState();
  if (text === null || text.server.serverId !== serverId) return null;
  useCallTextStore.setState({ text: null });
  return text;
}
