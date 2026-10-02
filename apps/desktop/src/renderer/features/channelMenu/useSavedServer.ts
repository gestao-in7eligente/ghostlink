import { useEffect, useState } from 'react';
import type { ChannelPrefsPatch, SavedServer } from '../../../shared/ipcTypes.js';
import { useSavedListStore } from '../../stores/savedList.js';

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

/** Changes one channel's choices on this computer; the sidebar and the notifications read the list again. */
export function setChannelPrefs(serverId: string, channelId: string, patch: ChannelPrefsPatch): void {
  window.ghostlink.servers.setChannel(serverId, channelId, patch).then(
    () => useSavedListStore.getState().changed(),
    () => undefined,
  );
}
