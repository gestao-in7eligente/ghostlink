import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import type { AttachmentView } from './attachmentModel.js';
import a from './attachments.module.css';

/** What "Baixar" does with an attachment; the default asks main to save it (always with the system dialog). */
export type DownloadHandler = (item: AttachmentView) => Promise<void>;

/** Main shows the save dialog and writes the file; nothing is ever opened (spec §1). */
export const saveAttachment: DownloadHandler = async (item) => {
  if (item.src === null) throw new Error('NOT_FOUND');
  await window.ghostlink.attachments.save(item.src, item.name);
};

/** A download in flight and its failure, for one button. */
export function useDownload(item: AttachmentView, onDownload: DownloadHandler = saveAttachment) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDownload(item);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  }, [busy, item, onDownload]);
  return { busy, error, run };
}

/** The download icon of a file card or an audio player, with its error line. */
export function DownloadButton({ item, onDownload }: { item: AttachmentView; onDownload?: DownloadHandler }) {
  const t = useT();
  const { busy, error, run } = useDownload(item, onDownload);
  const label = t('attachments.downloadName', { name: item.name });
  return (
    <>
      <button type="button" className={a.iconButton} onClick={() => void run()} disabled={busy || item.src === null} aria-label={label} title={label} data-download>
        <Download size={20} aria-hidden="true" />
      </button>
      {error && (
        <p className={a.downloadError} role="alert">
          {errorMessage(t, error)}
        </p>
      )}
    </>
  );
}
