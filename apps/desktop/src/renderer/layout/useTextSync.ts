// Keeps the text stores in step with the server on screen: every welcome (join or
// reconnect) resets them, its events are applied as they arrive (a call's server in the
// background has its own, stores/callText.ts), mentions and replies raise a desktop
// notification, and a notification click opens its channel.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { parseTextEvent, snapshotFromWelcome } from '../features/chat/events.js';
import { notificationFor } from '../features/chat/notify.js';
import { useT } from '../i18n/index.js';
import { takeCallText } from '../stores/callText.js';
import { useConnectionStore } from '../stores/connection.js';
import { dispatchText, textState, useTextStore } from '../stores/text.js';

const TYPING_PRUNE_MS = 1_000;

export function useTextSync(welcome: RendererWelcome): void {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  // Layout effects run in the same task as the render that received the welcome,
  // before the next IPC message, so no event is applied to a stale snapshot.
  // Back on the call's server (chamada-continua §1): its kept, live state instead of the welcome
  // main handed back, which is as old as the connection.
  useLayoutEffect(() => {
    const kept = takeCallText(welcome.serverId);
    if (kept) useTextStore.setState(kept);
    else dispatchText({ type: 'reset', snapshot: snapshotFromWelcome(welcome) });
  }, [welcome]);

  useLayoutEffect(
    () =>
      window.ghostlink.onServerEvent((envelope, serverId) => {
        if (serverId !== useConnectionStore.getState().welcome?.serverId) return;
        const event = parseTextEvent(envelope);
        if (!event) return;
        dispatchText({ type: 'event', event, now: Date.now() });
        if (event.t === 'msg.new') {
          const note = notificationFor(textState(), event.message, tRef.current);
          if (note) window.ghostlink.notifications.show(note).catch(() => undefined);
        }
      }),
    [],
  );

  useEffect(
    () =>
      window.ghostlink.onOpenChannel(({ channelId }) => {
        dispatchText({ type: 'select', channelId });
      }),
    [],
  );

  // "Digitando…" entries expire on their own.
  const typing = useTextStore((s) => s.messages.typing);
  useEffect(() => {
    if (Object.keys(typing).length === 0) return;
    const timer = setInterval(() => dispatchText({ type: 'typing.prune', now: Date.now() }), TYPING_PRUNE_MS);
    return () => clearInterval(timer);
  }, [typing]);
}
