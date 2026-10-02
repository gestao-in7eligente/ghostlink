// Opening a ghostlink://channel/<serverKeyId>/<channelId> link (spec 2026-10-02-menu-do-canal §2, "Copiar link"):
// the saved server with that key opens (connecting when it is not on screen) and the channel is selected,
// when I can see it. A server not in my list says "Você não está nesse servidor".
import { create } from 'zustand';
import type { ChannelLinkTarget, SavedServer } from '../../../shared/ipcTypes.js';
import { useLayoutSlots } from '../../layout/slots.js';
import { useConnectionStore } from '../../stores/connection.js';
import { dispatchText, textState } from '../../stores/text.js';
import { cancelChannelRequest, channelLinkPlan, requestChannel } from './channelRequest.js';

/** "Você não está nesse servidor": shown over any screen until dismissed. */
export const useChannelLinkNotice = create<{ unknownServer: boolean; show(): void; dismiss(): void }>()((set) => ({
  unknownServer: false,
  show: () => set({ unknownServer: true }),
  dismiss: () => set({ unknownServer: false }),
}));

export async function openChannelLink(link: ChannelLinkTarget): Promise<void> {
  const api = window.ghostlink;
  let saved: SavedServer[];
  try {
    saved = await api.servers.list();
  } catch {
    return;
  }
  const { welcome, state } = useConnectionStore.getState();
  const onScreen = welcome !== null && state !== 'idle' && textState().server.serverId === welcome.serverId ? welcome.serverId : null;
  const plan = channelLinkPlan(link, saved, onScreen);
  if (plan.kind === 'unknown') {
    useChannelLinkNotice.getState().show();
    return;
  }
  if (plan.kind === 'select') {
    dispatchText({ type: 'select', channelId: link.channelId });
    return;
  }
  // Like a click on it in the rail: Hosting may take over (a stopped server hosted here).
  if (useLayoutSlots.getState().onOpenServer?.(plan.server)) return;
  requestChannel(link.serverKeyId, link.channelId);
  try {
    const next = await api.servers.connect(plan.server.id);
    useConnectionStore.getState().dispatch({ type: 'joined', welcome: next });
  } catch {
    cancelChannelRequest();
  }
}
