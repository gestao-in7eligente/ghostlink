// The call goes on while browsing (spec 2026-10-01-chamada-continua-design.md §1, §2): main
// is told which server the call runs on, so that connection outlives a switch to another
// server or to the Home screen; while it is off screen, its text state is kept live by its
// own events (the voice UI's names, photos and channels, and an instant way back).
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { parseTextEvent, snapshotFromWelcome } from '../features/chat/events.js';
// From these modules, not the feature index: the index pulls React components and DOM APIs.
import { provideCallDirectory } from '../features/voice/runtime.js';
import { callServerId, useVoiceStore, type VoiceState } from '../features/voice/state.js';
import { useCallTextStore } from '../stores/callText.js';
import { useConnectionStore } from '../stores/connection.js';
import { textReducer, useTextStore } from '../stores/text.js';
import type { TextState } from '../stores/textState.js';
import { voiceDirectoryFromText } from './voiceDirectory.js';

/** Starts following the call's server. Returns the unsubscribe. */
export function followCallServer(): () => void {
  const api = window.ghostlink;

  // Main keeps the call's connection while the call runs, and closes it when it ends off screen.
  let announced: string | null = null;
  const announce = (v: VoiceState) => {
    const id = callServerId(v);
    if (id === announced) return;
    announced = id;
    void api.servers.setCall(id).catch(() => undefined);
  };
  announce(useVoiceStore.getState());
  const offVoice = useVoiceStore.subscribe((v) => {
    announce(v);
    if (callServerId(v) === null && useCallTextStore.getState().text !== null) useCallTextStore.setState({ text: null });
  });

  // The screen leaves the call's server: its text state stays, as it was on screen.
  const offConnection = useConnectionStore.subscribe((c, prev) => {
    const call = callServerId(useVoiceStore.getState());
    if (call === null || prev.welcome?.serverId !== call || c.welcome?.serverId === call) return;
    const { server, channels, messages, members, bots } = useTextStore.getState();
    if (server.serverId === call) useCallTextStore.setState({ text: { server, channels, messages, members, bots } });
  });

  // ...then the call connection's events keep it live (a reconnect's welcome replaces it, spec §13).
  const offEvents = api.onServerEvent((envelope, serverId) => {
    const kept = useCallTextStore.getState().text;
    if (kept === null || serverId !== kept.server.serverId || serverId === useConnectionStore.getState().welcome?.serverId) return;
    let next: TextState = kept;
    if (envelope.t === 'welcome') {
      next = textReducer(kept, { type: 'reset', snapshot: snapshotFromWelcome(envelope.d as RendererWelcome) });
    } else {
      const event = parseTextEvent(envelope);
      if (event) next = textReducer(kept, { type: 'event', event, now: Date.now() });
    }
    if (next !== kept) useCallTextStore.setState({ text: next });
  });

  // The voice UI's names, photos and channels of the call's server while it is off screen.
  const provide = (text: TextState | null) => provideCallDirectory(text === null ? null : voiceDirectoryFromText(text));
  provide(useCallTextStore.getState().text);
  const offText = useCallTextStore.subscribe((s, prev) => {
    if (s.text !== prev.text) provide(s.text);
  });

  return () => {
    offText();
    offEvents();
    offConnection();
    offVoice();
    provideCallDirectory(null);
  };
}
