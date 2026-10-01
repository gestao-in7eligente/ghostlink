import { memo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { fitImage, formatSize, middleEllipsis, mosaicRows, type AttachmentView } from './attachmentModel.js';
import a from './attachments.module.css';
import { DownloadButton, type DownloadHandler } from './DownloadButton.js';
import { FileIcon } from './FileIcon.js';
import { Lightbox } from './Lightbox.js';

/** Height of a mosaic row by how many images share it (the grid is 400 px wide, 4 px gaps). */
const ROW_HEIGHT: Readonly<Record<number, number>> = { 1: 220, 2: 198, 3: 131 };

/**
 * A message's files (spec §1): images inside it (one fitted in 400×300, several in a grid; a
 * click opens the lightbox), video and audio with the native player, and a card with "Baixar"
 * for anything else. Pure data in: servers and DMs map their records to AttachmentView.
 */
export const AttachmentList = memo(function AttachmentList({ items, onDownload }: { items: readonly AttachmentView[]; onDownload?: DownloadHandler }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return null;
  const images = items.filter((x) => x.kind === 'image');
  const others = items.filter((x) => x.kind !== 'image');
  return (
    <div className={a.list} aria-label={t('attachments.list')} role="group" data-attachments>
      {images.length === 1 && <SingleImage item={images[0]!} onOpen={() => setOpen(0)} />}
      {images.length > 1 && <Mosaic images={images} onOpen={setOpen} />}
      {others.map((item) =>
        item.kind === 'video' && item.src !== null ? (
          <VideoPlayer key={item.key} item={item} />
        ) : (
          <FileCard key={item.key} item={item} onDownload={onDownload} />
        ),
      )}
      {open !== null && images.length > 0 && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onDownload={onDownload} />}
    </div>
  );
});

/** An <img> that turns into "Arquivo indisponível" when it cannot load (deleted, no access, offline). */
function Picture({ item, width, height }: { item: AttachmentView; width?: number; height?: number }) {
  const t = useT();
  const [failed, setFailed] = useState<string | null>(null);
  if (item.src === null || failed === item.src) {
    return (
      <span className={a.missing} style={width && height ? { width, height } : undefined}>
        <ImageOff size={22} aria-hidden="true" />
        {item.note ?? t('attachments.unavailable')}
      </span>
    );
  }
  return <img src={item.src} alt={item.name} width={width} height={height} draggable={false} decoding="async" onError={() => setFailed(item.src)} />;
}

function SingleImage({ item, onOpen }: { item: AttachmentView; onOpen: () => void }) {
  const t = useT();
  // Known sides reserve the space before the bytes arrive, so the list does not jump.
  const size = fitImage(item.width, item.height);
  return (
    <button type="button" className={a.single} onClick={onOpen} aria-label={t('attachments.open', { name: item.name })} title={item.name} data-attachment="image">
      <Picture item={item} width={size?.width} height={size?.height} />
    </button>
  );
}

function Mosaic({ images, onOpen }: { images: readonly AttachmentView[]; onOpen: (index: number) => void }) {
  const t = useT();
  let start = 0;
  return (
    <div className={a.mosaic}>
      {mosaicRows(images.length).map((count, row) => {
        const first = start;
        start += count;
        return (
          <div key={row} className={a.mosaicRow} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, height: ROW_HEIGHT[count] }}>
            {images.slice(first, first + count).map((item, i) => (
              <button
                key={item.key}
                type="button"
                className={a.cell}
                onClick={() => onOpen(first + i)}
                aria-label={t('attachments.open', { name: item.name })}
                title={item.name}
                data-attachment="image"
              >
                <Picture item={item} />
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function VideoPlayer({ item }: { item: AttachmentView }) {
  const size = fitImage(item.width, item.height);
  return (
    // The native player, inside the message; saving goes through "Baixar" only (the save dialog).
    <video className={a.video} src={item.src ?? undefined} controls controlsList="nodownload" preload="metadata" width={size?.width} height={size?.height} aria-label={item.name} data-attachment="video" />
  );
}

/** Audio gets the native player under its card; anything else just the card with "Baixar". */
function FileCard({ item, onDownload }: { item: AttachmentView; onDownload?: DownloadHandler }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  return (
    <div className={a.card} data-attachment={item.kind} aria-label={`${t(`attachments.kind.${item.kind}`)}: ${item.name}`} role="group">
      <span className={a.cardIcon}>
        <FileIcon name={item.name} kind={item.kind} />
      </span>
      <span className={a.cardText}>
        <span className={a.cardName} title={item.name}>
          {middleEllipsis(item.name)}
        </span>
        <span className={a.cardSize}>{formatSize(item.size, locale)}</span>
        {item.src === null && item.note && <span className={a.cardNote}>{item.note}</span>}
      </span>
      <DownloadButton item={item} onDownload={onDownload} />
      {item.kind === 'audio' && item.src !== null && <audio className={a.audio} src={item.src} controls controlsList="nodownload" preload="metadata" aria-label={item.name} />}
    </div>
  );
}
