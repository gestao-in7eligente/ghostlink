import { useEffect, useLayoutEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { FEATURE_SERVER_DELETE } from '@ghostlink/shared';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { useConnectionStore } from '../../stores/connection.js';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { useDeletionStore } from './deletionStore.js';
import d from './serverDelete.module.css';
import { deletionBanner, exitMenuItem, type ServerExitAction } from './serverDeleteModel.js';

const TICK_MS = 30_000;

/**
 * Spec §3: while the server waits for its erase, the owner (the only one still let in) sees a red
 * band at the top: "{servidor} está fora do ar e será excluído em 47 h", with "Restaurar servidor".
 */
export function DeletionBanner({ serverId }: { serverId: string }) {
  const t = useT();
  const owner = useTextStore((st) => isOwner(st.server));
  const name = useTextStore((st) => st.server.name);
  const deletingAt = useDeletionStore((st) => (st.serverId === serverId ? st.deletingAt : null));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);

  useEffect(() => {
    if (deletingAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deletingAt]);

  const banner = deletionBanner({ owner, deletingAt, name, now });
  if (!banner) return null;

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.ghostlink.server.request('server.restore', {}, serverId);
      useDeletionStore.getState().dispatch({ type: 'restored', serverId });
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={d.banner} role="status" aria-label={t('serverDelete.bannerLabel')} data-testid="server-deleting-banner">
      <TriangleAlert className={d.bannerIcon} size={16} aria-hidden="true" />
      <p className={d.bannerText}>
        {t('serverDelete.banner', { name: banner.name, time: t(banner.countdown.key, banner.countdown.vars) })}
        {error && <span className={d.bannerError}> {errorMessage(t, error)}</span>}
      </p>
      <button type="button" className={d.bannerAction} onClick={() => void restore()} disabled={busy} data-testid="server-restore">
        {t('serverDelete.restore')}
      </button>
    </div>
  );
}

/** The open server's way out, for its menus: "Sair do servidor", "Excluir servidor" or nothing. */
export function useOpenServerExit(): ServerExitAction | null {
  const owner = useTextStore((st) => isOwner(st.server));
  const canDelete = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_SERVER_DELETE) === true);
  return exitMenuItem({ connected: true, owner, canDelete });
}

/** Keeps the store on the open server: every welcome (join or reconnect) and its events. */
export function useServerDeleteSync(welcome: RendererWelcome): void {
  useLayoutEffect(() => {
    useDeletionStore.getState().dispatch({ type: 'welcome', welcome });
  }, [welcome]);
  useLayoutEffect(
    () =>
      window.ghostlink.onServerEvent((event) => {
        useDeletionStore.getState().dispatch({ type: 'event', serverId: welcome.serverId, event });
      }),
    [welcome.serverId],
  );
}
