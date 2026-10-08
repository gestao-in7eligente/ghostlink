import { useEffect, useState } from 'react';
import { CircleArrowUp, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { ConfirmDialog } from '../../layout/primitives.js';
import { isOwner } from '../../stores/server.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import n from './serverUpdate.module.css';
import { noticeKey, ownerUpdateNotice, serverUpdateDocsUrl, type OwnerUpdateNotice } from './serverUpdateModel.js';
import { keepServerUpdate, managedFor, syncServerUpdate, useServerUpdateStore } from './serverUpdateStore.js';

/**
 * Spec 2026-10-01 §5: the band at the top of the chat that tells the owner the connected server
 * is behind the app — Discord's notice bar, in the app's blurple (amber when it needs the owner).
 * Nobody but the owner sees it.
 */
export function ServerUpdateNotice({ serverKeyId }: { serverKeyId: string }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  const owner = useTextStore((s) => isOwner(s.server));
  const serverVersion = useTextStore((s) => s.server.version);
  const appVersion = useServerUpdateStore((s) => s.appVersion);
  const managed = useServerUpdateStore((s) => managedFor(s.managed, serverKeyId));
  const dismissed = useServerUpdateStore((s) => s.dismissed);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => syncServerUpdate(window.ghostlink, serverKeyId), [serverKeyId]);

  const notice = ownerUpdateNotice({ isOwner: owner, serverVersion, appVersion, managed });
  if (!notice) return null;
  const key = noticeKey(serverKeyId, notice);
  if (dismissed.includes(key)) return null;

  const warn = notice.kind === 'managed' && (notice.state === 'failed' || notice.state === 'railwayDisconnected');
  const canUpdateNow = notice.kind === 'managed' && (notice.state === 'waiting' || notice.state === 'failed');
  // A refusal (Railway not connected…) stays in the dialog, which shows why.
  const updateNow = async () => keepServerUpdate(await window.ghostlink.serverUpdates.updateNow(serverKeyId));

  return (
    <div className={warn ? `${n.notice} ${n.warn}` : n.notice} role="status" aria-label={t('serverUpdate.label')} data-testid="server-update-notice">
      <NoticeIcon notice={notice} />
      <p className={n.text}>
        <NoticeText notice={notice} />
        {notice.kind === 'manual' && (
          <>
            {' ('}
            <button type="button" className={n.link} onClick={() => void window.ghostlink.app.openExternal(serverUpdateDocsUrl(locale)).catch(() => undefined)}>
              {t('serverUpdate.howTo')}
            </button>
            {')'}
          </>
        )}
      </p>
      {canUpdateNow && (
        <button type="button" className={n.action} onClick={() => setConfirming(true)}>
          {t('serverUpdate.updateNow')}
        </button>
      )}
      <button type="button" className={n.close} aria-label={t('serverUpdate.dismiss')} title={t('serverUpdate.dismiss')} onClick={() => useServerUpdateStore.getState().dismiss(key)}>
        <X size={16} aria-hidden="true" />
      </button>
      {confirming && (
        <ConfirmDialog
          title={t('serverUpdate.confirm.title')}
          body={t('serverUpdate.confirm.body')}
          confirmLabel={t('serverUpdate.updateNow')}
          danger={false}
          onConfirm={updateNow}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function NoticeIcon({ notice }: { notice: OwnerUpdateNotice }) {
  if (notice.kind === 'managed' && (notice.state === 'updating' || notice.state === 'addingAgent')) {
    return <LoaderCircle className={`${n.icon} ${n.spin}`} size={16} aria-hidden="true" />;
  }
  if (notice.kind === 'managed' && (notice.state === 'failed' || notice.state === 'railwayDisconnected')) {
    return <TriangleAlert className={n.icon} size={16} aria-hidden="true" />;
  }
  return <CircleArrowUp className={n.icon} size={16} aria-hidden="true" />;
}

/** The agent key comes from the licence roster (data); show it with a leading capital, e.g. "aurora" → "Aurora". */
function agentLabel(agent: string | undefined): string {
  if (!agent) return '';
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function NoticeText({ notice }: { notice: OwnerUpdateNotice }) {
  const t = useT();
  const vars = { version: notice.version, target: notice.target };
  if (notice.kind === 'manual') return <>{t('serverUpdate.manual', vars)}</>;
  switch (notice.state) {
    case 'waiting':
      return <>{t('serverUpdate.waiting', vars)}</>;
    case 'updating':
      return <>{t('serverUpdate.updating', vars)}</>;
    case 'failed':
      return <>{t('serverUpdate.failed', vars)}</>;
    case 'railwayDisconnected':
      return <>{t('serverUpdate.railwayDisconnected', vars)}</>;
    case 'addingAgent':
      return <>{t('serverUpdate.addingAgent', { agent: agentLabel(notice.agent) })}</>;
  }
}
