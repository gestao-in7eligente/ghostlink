import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { errorMessage, useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { formatSize, type AttachmentView } from './attachmentModel.js';
import a from './attachments.module.css';
import { useDownload, type DownloadHandler } from './DownloadButton.js';

/**
 * The image large (spec §1): over the whole window, with "Baixar". Esc or a click outside the
 * picture closes it; ← and → go through the message's images. Focus comes back afterwards.
 * `images` is never empty (the list unmounts it when a message loses its images).
 */
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  onDownload,
}: {
  images: readonly AttachmentView[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onDownload?: DownloadHandler;
}) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  const root = useRef<HTMLDivElement>(null);
  const at = Math.min(Math.max(0, index), images.length - 1);
  const image = images[at]!;
  const many = images.length > 1;
  const { busy, error, run } = useDownload(image, onDownload);
  const [broken, setBroken] = useState<string | null>(null);

  // Focus moves in, and back to whatever had it (the thumbnail) when the lightbox closes.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const go = (step: number) => onIndex((at + step + images.length) % images.length);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (many && e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (many && e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'Tab') {
      // Keep Tab inside: the page behind is covered.
      const list = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list.at(-1)!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      ref={root}
      className={a.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={t('attachments.lightbox', { name: image.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={a.stage} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {image.src !== null && broken !== image.src ? (
          <img key={image.key} src={image.src} alt={image.name} draggable={false} onError={() => setBroken(image.src)} />
        ) : (
          <p className={a.missing}>{image.note ?? t('attachments.unavailable')}</p>
        )}
        <button type="button" className={a.lightboxClose} onClick={onClose} aria-label={t('ui.close')} title={t('ui.close')}>
          <X size={20} aria-hidden="true" />
        </button>
        {many && (
          <>
            <button type="button" className={`${a.lightboxNav} ${a.lightboxPrev}`} onClick={() => go(-1)} aria-label={t('attachments.previous')} title={t('attachments.previous')}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <button type="button" className={`${a.lightboxNav} ${a.lightboxNext}`} onClick={() => go(1)} aria-label={t('attachments.next')} title={t('attachments.next')}>
              <ChevronRight size={24} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      <div className={a.lightboxBar}>
        <div className={a.lightboxInfo}>
          <span className={a.lightboxName} title={image.name}>
            {image.name}
          </span>
          <span className={a.lightboxMeta}>
            {formatSize(image.size, locale)}
            {image.width && image.height ? ` · ${image.width}×${image.height}` : ''}
            {many ? ` · ${t('attachments.position', { index: at + 1, total: images.length })}` : ''}
          </span>
          {error && (
            <p className={a.lightboxError} role="alert">
              {errorMessage(t, error)}
            </p>
          )}
        </div>
        <button type="button" className={a.lightboxButton} onClick={() => void run()} disabled={busy || image.src === null} data-download>
          <Download size={18} aria-hidden="true" />
          {t('attachments.download')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
