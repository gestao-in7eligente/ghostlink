import { useEffect } from 'react';
import type { DeepLink } from '../../../shared/ipcTypes.js';
import { openChannelLink } from '../channelMenu/openChannelLink.js';
import { useDeepLinkStore } from './deepLinkStore.js';

/**
 * Takes the link that started the app, then listens for new ones (spec §12). An invite waits for
 * "Aceitar convite"; a channel link opens that saved server's channel (channel menu, "Copiar link").
 */
export function useDeepLinkSync(attempt: number): void {
  useEffect(() => {
    const api = window.ghostlink;
    const { offer } = useDeepLinkStore.getState();
    const route = (link: DeepLink) => {
      if (link.kind === 'channel') void openChannelLink(link);
      else offer(link);
    };
    const off = api.onDeepLink(route);
    let alive = true;
    api.deepLink.take().then(
      (link) => alive && link && route(link),
      () => {},
    );
    return () => {
      alive = false;
      off();
    };
  }, [attempt]);
}
