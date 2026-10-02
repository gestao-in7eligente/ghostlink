// Keeps the text stores in step with the server on screen: every welcome (join or
// reconnect) resets them, its events are applied as they arrive (a call's server in the
// background has its own, stores/callText.ts), new messages raise a desktop notification
// as the channel's choices say (its menu: muted, or its own mode) or else the server's (its menu
// in the rail), and a notification click opens its channel.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { effectiveNotifyMode } from '../features/channelMenu/channelPrefs.js';
import { takeChannelRequest } from '../features/channelMenu/channelRequest.js';
import { parseTextEvent, snapshotFromWelcome } from '../features/chat/events.js';
import { notificationFor } from '../features/chat/notify.js';
import { useT } from '../i18n/index.js';
import { takeCallText } from '../stores/callText.js';
import { useConnectionStore } from '../stores/connection.js';
import { useSavedListStore } from '../stores/savedList.js';
import { dispatchText, textState, useTextStore } from '../stores/text.js';

const TYPING_PRUNE_MS = 1_000;

export function useTextSync(welcome: RendererWelcome): void {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  /** Each saved server's entry (its notification mode and its channels' choices), read again whenever the list changes. */
  const saved = useRef(new Map<string, SavedServer>());
  const listRevision = useSavedListStore((s) => s.revision);

  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => {
        if (alive) saved.current = new Map(list.map((s) => [s.id, s]));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [listRevision]);

  // Layout effects run in the same task as the render that received the welcome,
  // before the next IPC message, so no event is applied to a stale snapshot.
  // Back on the call's server (chamada-continua §1): its kept, live state instead of the welcome
  // main handed back, which is as old as the connection.
  useLayoutEffect(() => {
    const kept = takeCallText(welcome.serverId);
    if (kept) useTextStore.setState(kept);
    else dispatchText({ type: 'reset', snapshot: snapshotFromWelcome(welcome) });
    // An invite to a channel, or a channel link (channel menu §2): that channel opens, when I can see it.
    const channelId = takeChannelRequest(welcome.server.serverKeyId);
    if (channelId !== null) dispatchText({ type: 'select', channelId });
  }, [welcome]);

  useLayoutEffect(
    () =>
      window.ghostlink.onServerEvent((envelope, serverId) => {
        if (serverId !== useConnectionStore.getState().welcome?.serverId) return;
        const event = parseTextEvent(envelope);
        if (!event) return;
        dispatchText({ type: 'event', event, now: Date.now() });
        if (event.t === 'msg.new') {
          const mode = effectiveNotifyMode(saved.current.get(serverId), event.message.channelId, Date.now());
          const note = notificationFor(textState(), event.message, tRef.current, mode);
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
