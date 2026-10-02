import { useEffect, useState } from 'react';
import type { ChannelPrefsPatch, SavedServer } from '../../../shared/ipcTypes.js';
import { useSavedListStore } from '../../stores/savedList.js';

const CHANNEL_ID = /^[A-Z2-7]{26}$/;

/** My saved servers, read again whenever the list changes (channel links in messages name them). */
export function useSavedServers(): readonly SavedServer[] {
  const revision = useSavedListStore((s) => s.revision);
  const [list, setList] = useState<readonly SavedServer[]>([]);
  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (next) => alive && setList(next),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [revision]);
  return list;
}

/** The saved entry of server `id` (its channel choices and pins), read again whenever the saved list changes. */
export function useSavedServer(id: string | null): SavedServer | null {
  const revision = useSavedListStore((s) => s.revision);
  const [entry, setEntry] = useState<SavedServer | null>(null);
  useEffect(() => {
    if (id === null) {
      setEntry(null);
      return;
    }
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => alive && setEntry(list.find((s) => s.id === id) ?? null),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [id, revision]);
  return entry?.id === id ? entry : null;
}

/**
 * A channel of saved server `serverId` was deleted (its `channel.deleted`, `data` unchecked): its pin,
 * mode and mute go too. Main writes nothing when it had none.
 */
export function forgetDeletedChannel(serverId: string, data: unknown): void {
  const id = typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || !CHANNEL_ID.test(id)) return;
  setChannelPrefs(serverId, id, { notify: null, mutedUntil: false, pinned: false });
}

/** Changes one channel's choices on this computer; the sidebar and the notifications read the list again. */
export function setChannelPrefs(serverId: string, channelId: string, patch: ChannelPrefsPatch): void {
  window.ghostlink.servers.setChannel(serverId, channelId, patch).then(
    () => useSavedListStore.getState().changed(),
    () => undefined,
  );
}
