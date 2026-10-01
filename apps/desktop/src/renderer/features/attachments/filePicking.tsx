// Getting files into a composer (spec §1): the "+" picker, drag and drop over the chat, and
// Ctrl+V of an image; then the tray's rules. Shared by server channels and DMs.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from 'react';
import { Upload } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settings.js';
import { addToTray, formatSize, kindFromMime, summarizeRejections, type TrayItem, type TrayLimits, type TrayRejection } from './attachmentModel.js';
import a from './attachments.module.css';

/** A file in the tray, with the File it came from (read only when the message is sent). */
export interface TrayFile extends TrayItem {
  file: File;
}

/** What a sender keeps of a tray file once the tray is emptied: no thumbnail any more. */
export type PickedFile = Omit<TrayFile, 'preview'>;

function newId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * The tray of one composer: adds files under `limits`, keeps the thumbnails' blob: URLs and
 * revokes them when files leave (or the composer goes away). `rejected` explains what stayed out.
 */
export function useTray(limits: TrayLimits) {
  const [items, setItems] = useState<TrayFile[]>([]);
  const [rejected, setRejected] = useState<TrayRejection[]>([]);
  const current = useRef(items);
  current.current = items;

  useEffect(
    () => () => {
      for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const { accepted, rejected: out } = addToTray(current.current, files, limits);
      setRejected(out);
      if (accepted.length === 0) return;
      const added = accepted.map((file): TrayFile => {
        const kind = kindFromMime(file.type);
        return { id: newId(), name: file.name, size: file.size, kind, preview: kind === 'image' ? URL.createObjectURL(file) : null, file };
      });
      const next = [...current.current, ...added];
      current.current = next;
      setItems(next);
    },
    [limits.maxFiles, limits.maxBytes],
  );

  const remove = useCallback((id: string) => {
    const gone = current.current.find((x) => x.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    const next = current.current.filter((x) => x.id !== id);
    current.current = next;
    setItems(next);
    setRejected([]);
  }, []);

  /** Empties the tray for sending: the files, without their thumbnails. */
  const take = useCallback((): PickedFile[] => {
    const taken = current.current;
    current.current = [];
    setItems([]);
    setRejected([]);
    return taken.map(({ preview, ...rest }) => {
      if (preview) URL.revokeObjectURL(preview);
      return rest;
    });
  }, []);

  return { items, rejected, add, remove, take, clearNotice: useCallback(() => setRejected([]), []) };
}

/** What stayed out of the tray, one line per reason. */
export function TrayNotice({ rejected, limits }: { rejected: readonly TrayRejection[]; limits: TrayLimits }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  if (rejected.length === 0) return null;
  const size = limits.maxBytes === null ? '' : formatSize(limits.maxBytes, locale);
  return (
    <div role="alert">
      {summarizeRejections(rejected).map((r) => (
        <p key={r.reason} className={a.trayNotice}>
          {r.reason === 'tooMany'
            ? t('attachments.tooMany', { max: limits.maxFiles })
            : r.reason === 'tooLarge'
              ? r.count === 1
                ? t('attachments.tooLarge', { name: r.name, size })
                : t('attachments.tooLargeMany', { count: r.count, size })
              : r.count === 1
                ? t('attachments.empty', { name: r.name })
                : t('attachments.emptyMany', { count: r.count })}
        </p>
      ))}
    </div>
  );
}

/** The hidden <input type="file"> behind the "+" button; `open()` shows the system picker. */
export function useFilePicker(onFiles: (files: File[]) => void): { open: () => void; input: ReactElement } {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      tabIndex={-1}
      data-attachment-input
      onChange={(e) => {
        const files = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = ''; // the same file can be picked again
        onFiles(files);
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

function carriesFiles(e: DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files');
}

/**
 * Drag and drop of files over an area (the whole chat): `dragging` while files hover it, so the
 * overlay shows; text or links being dragged are left alone.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setDragging(false);
    }
  }, [enabled]);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFiles([...e.dataTransfer.files]);
    },
  };
  return { dragging, handlers };
}

/** "Soltar para anexar" over the chat while files hover it. */
export function DropOverlay({ target, maxFiles }: { target: string; maxFiles: number }) {
  const t = useT();
  return (
    <div className={a.dropOverlay} aria-hidden="true" data-drop-overlay>
      <div className={a.dropCard}>
        <Upload size={36} aria-hidden="true" />
        <p className={a.dropTitle}>{t('attachments.dropTitle')}</p>
        <p className={a.dropHint}>{t('attachments.dropTo', { target })}</p>
        <p className={a.dropHint}>{t('attachments.dropHint', { max: maxFiles })}</p>
      </div>
    </div>
  );
}

/**
 * Files in a paste (Ctrl+V of a screenshot or a copied file); [] for plain text, which then
 * pastes as usual. Text copied from an office app also carries a picture of itself: with text
 * there and only images besides, the text wins. A nameless image gets `fallbackName` and its
 * type's extension.
 */
export function pastedFiles(e: ClipboardEvent, fallbackName: string): File[] {
  const files = [...e.clipboardData.files];
  if (files.length === 0) return [];
  const text = e.clipboardData.getData('text/plain');
  if (text.trim() !== '' && files.every((f) => f.type.startsWith('image/'))) return [];
  return files.map((file) => {
    if (file.name !== '') return file;
    const ext = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    return new File([file], `${fallbackName}.${ext}`, { type: file.type, lastModified: file.lastModified });
  });
}
