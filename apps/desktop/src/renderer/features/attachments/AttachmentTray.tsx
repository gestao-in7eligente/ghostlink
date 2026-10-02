import { Trash2 } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { formatSize, type TrayItem } from './attachmentModel.js';
import a from './attachments.module.css';
import { FileIcon } from './FileIcon.js';

/**
 * The files waiting in the composer (spec §1): a thumbnail for images, the icon and name for
 * the rest, each with its button to take it out. It sits on top of the message box.
 */
export function AttachmentTray({ items, onRemove }: { items: readonly TrayItem[]; onRemove: (id: string) => void }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  if (items.length === 0) return null;
  return (
    <ul className={a.tray} aria-label={t('attachments.tray')} data-attachment-tray>
      {items.map((item) => {
        const label = t('attachments.remove', { name: item.name });
        return (
          <li key={item.id} className={a.trayItem} data-tray-item={item.kind}>
            <span className={a.trayThumb}>{item.preview !== null ? <img src={item.preview} alt="" draggable={false} /> : <FileIcon name={item.name} kind={item.kind} size={40} />}</span>
            <span className={a.trayName} title={item.name}>
              {item.name}
            </span>
            <span className={a.traySize}>{formatSize(item.size, locale)}</span>
            <button type="button" className={a.trayRemove} onClick={() => onRemove(item.id)} aria-label={label} title={label}>
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
