import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { formatSize, percent, type UploadView } from './attachmentModel.js';
import a from './attachments.module.css';
import { FileIcon } from './FileIcon.js';

/**
 * The files of a message still being sent (spec §1): one bar each. `failed` paints the bars
 * of the files that did not get through; the message itself shows the reason and "Tentar de novo".
 */
export function UploadProgress({ files, failed = false }: { files: readonly UploadView[]; failed?: boolean }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  if (files.length === 0) return null;
  return (
    <ul className={a.uploads} aria-label={t('attachments.list')} data-uploads>
      {files.map((file) => {
        const value = file.done ? 100 : percent(file.progress);
        const fill = file.done ? a.barDone : failed ? a.barFailed : '';
        return (
          <li key={file.id} className={a.upload} data-upload={file.done ? 'done' : failed ? 'failed' : 'sending'}>
            <FileIcon name={file.name} kind={file.kind} size={22} />
            <span className={a.uploadName} title={file.name}>
              {file.name} <span className={a.uploadPercent}>· {formatSize(file.size, locale)}</span>
            </span>
            <span className={a.uploadPercent}>{file.done ? t('attachments.uploaded') : `${value}%`}</span>
            <span
              className={a.bar}
              role="progressbar"
              aria-label={t('attachments.progressLabel', { name: file.name, percent: value })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
            >
              <span className={`${a.barFill} ${fill}`} style={{ width: `${failed && !file.done ? 100 : value}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
