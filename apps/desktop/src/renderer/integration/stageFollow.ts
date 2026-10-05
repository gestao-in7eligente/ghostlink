// The voice stage (the center of the main layout) and the call are two stores: Text's
// `stageId` and Voice's `call`. When a moderator moves me (voice.forceMove), the call
// changes channel on its own; the stage must go with it, as the Voice track's own screen
// did, or it keeps showing the room I was taken out of (and its "Entrar na voz").
import { useVoiceStore } from '../features/voice/state.js';
import { dispatchText, useTextStore } from '../stores/text.js';

/**
 * The stage to show once the call went from `from` (the channel it was last in) to `to`:
 * the new channel if the stage showed the old one, else whatever was on screen (the
 * chat, or a channel I opened myself).
 */
export function stageAfterCallMove(stageId: string | null, from: string | null, to: string | null): string | null {
  if (from === null || to === null || from === to) return stageId;
  return stageId === from ? to : stageId;
}

/** Keeps the stage on the call when it moves by itself. Returns the unsubscribe. */
export function followCallOnStage(): () => void {
  // The last channel the call was in: a move passes through idle (the old room is torn down first).
  let last = useVoiceStore.getState().call.channelId;
  return useVoiceStore.subscribe((state) => {
    const current = state.call.channelId;
    if (current === null || current === last) return;
    const from = last;
    last = current;
    const stageId = useTextStore.getState().channels.stageId;
    const next = stageAfterCallMove(stageId, from, current);
    if (next !== stageId) dispatchText({ type: 'stage', channelId: next });
  });
}
