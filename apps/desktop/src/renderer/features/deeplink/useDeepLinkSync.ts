import { useEffect } from 'react';
import { useDeepLinkStore } from './deepLinkStore.js';

/** Takes the link that started the app, then listens for new ones (spec §12). */
export function useDeepLinkSync(attempt: number): void {
  useEffect(() => {
    const api = window.ghostlink;
    const { offer } = useDeepLinkStore.getState();
    const off = api.onDeepLink((link) => offer(link));
    let alive = true;
    api.deepLink.take().then(
      (link) => alive && link && offer(link),
      () => {},
    );
    return () => {
      alive = false;
      off();
    };
  }, [attempt]);
}
