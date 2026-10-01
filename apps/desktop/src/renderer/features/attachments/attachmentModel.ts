// Attachments as the shared pieces see them (spec 2026-10-01-anexos §1, §4): plain data, the
// same for server channels and direct messages. Each side maps its own records to these shapes;
// nothing here knows about servers, sessions or friends. Pure functions only (tested in node).

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** Files per message, in channels and in DMs (spec §1). */
export const MAX_ATTACHMENTS = 10;

/** The box one image fits in inside a message, keeping its proportions (spec §1). */
export const IMAGE_BOX = { width: 400, height: 300 } as const;

/** One attachment of a message, ready to show. */
export interface AttachmentView {
  /** Unique within the message (a server's fileId, a DM file's hash). */
  key: string;
  name: string;
  /** Bytes. */
  size: number;
  kind: AttachmentKind;
  mime: string;
  /** Images: the sides the sender's side read from the header. */
  width?: number;
  height?: number;
  /** Where the page loads it from (app://ghostlink/_file/… or _dmfile/…); null while it is not here yet. */
  src: string | null;
  /** Shown in place of the media while `src` is null, e.g. "Chega quando Bia estiver online". */
  note?: string;
}

/** One file in the composer's tray, before it is sent. */
export interface TrayItem {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** A blob: URL for an image's thumbnail, or null (icon and name). The owner of the item revokes it. */
  preview: string | null;
}

/** One file of a message still being sent: its own progress bar and failure. */
export interface UploadView {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** 0 to 1. */
  progress: number;
  /** Uploaded: only the message itself is still on its way. */
  done: boolean;
}

const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const VIDEO_MIMES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);
const AUDIO_MIMES: ReadonlySet<string> = new Set(['audio/mpeg', 'audio/mp3', 'audio/ogg']);

/**
 * The kind a picked file will most likely get, from the type the system reports (the tray's
 * thumbnail). Only a guess: the server (or the DM engine) decides from the bytes.
 */
export function kindFromMime(mime: string): AttachmentKind {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (IMAGE_MIMES.has(m)) return 'image';
  if (VIDEO_MIMES.has(m)) return 'video';
  if (AUDIO_MIMES.has(m)) return 'audio';
  return 'file';
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * "820 B", "14 KB", "1,5 MB" (pt-BR) / "1.5 MB" (en): powers of 1024, one decimal below 10
 * and none from there, as file managers show sizes. The units read the same in both languages.
 */
export function formatSize(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  // 1023.96 KB would round to "1024 KB": show the next unit instead.
  if (value >= 1023.95 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  return `${text} ${UNITS[unit]}`;
}

/** Megabytes (as the servers count their limits) in bytes. */
export function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

/**
 * The size an image is drawn at inside a message: as large as it is, but inside `box`, keeping
 * its proportions (spec §1: up to 400×300). null when the sides are unknown (the CSS caps it).
 */
export function fitImage(width: number | undefined, height: number | undefined, box: { width: number; height: number } = IMAGE_BOX): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const scale = Math.min(1, box.width / width, box.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How several images of one message share the grid: rows of up to three, the shorter row
 * first (2 → [2], 4 → [2, 2], 5 → [2, 3], 7 → [1, 3, 3], 10 → [1, 3, 3, 3]). One image is not a grid.
 */
export function mosaicRows(count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  if (n <= 3) return n === 0 ? [] : [n];
  if (n === 4) return [2, 2];
  const rest = n % 3;
  const rows: number[] = rest === 0 ? [] : [rest];
  for (let i = 0; i < Math.floor(n / 3); i++) rows.push(3);
  return rows;
}

/** Height of a mosaic row by how many images share it (the grid is 400 px wide, 4 px gaps). */
export const MOSAIC_ROW_HEIGHT: Readonly<Record<number, number>> = { 1: 220, 2: 198, 3: 131 };

/** Roughly how tall a message's files stand (the list's first guess before it measures the row). */
export function attachmentsHeight(items: ReadonlyArray<Pick<AttachmentView, 'kind' | 'width' | 'height'>>): number {
  if (items.length === 0) return 0;
  const images = items.filter((x) => x.kind === 'image');
  let height = 8;
  if (images.length === 1) height += fitImage(images[0]!.width, images[0]!.height)?.height ?? IMAGE_BOX.height;
  else if (images.length > 1) height += mosaicRows(images.length).reduce((sum, n) => sum + (MOSAIC_ROW_HEIGHT[n] ?? 131) + 4, 0);
  for (const x of items) {
    if (x.kind === 'video') height += (fitImage(x.width, x.height)?.height ?? 225) + 6;
    else if (x.kind === 'audio') height += 112;
    else if (x.kind === 'file') height += 70;
  }
  return height;
}

export type TrayRejectionReason = 'tooMany' | 'tooLarge' | 'empty';

export interface TrayRejection {
  name: string;
  reason: TrayRejectionReason;
}

export interface TrayLimits {
  maxFiles: number;
  /** The largest file the destination takes (a server's upload limit); null: no limit known. */
  maxBytes: number | null;
}

/**
 * The tray's rules (spec §1): empty files and files over the limit stay out, and no more than
 * `maxFiles` in all. `accepted` keeps the order the files came in.
 */
export function addToTray<T extends { name: string; size: number }>(
  current: readonly unknown[],
  incoming: readonly T[],
  limits: TrayLimits,
): { accepted: T[]; rejected: TrayRejection[] } {
  const accepted: T[] = [];
  const rejected: TrayRejection[] = [];
  let room = Math.max(0, limits.maxFiles - current.length);
  for (const file of incoming) {
    if (file.size <= 0) rejected.push({ name: file.name, reason: 'empty' });
    else if (limits.maxBytes !== null && file.size > limits.maxBytes) rejected.push({ name: file.name, reason: 'tooLarge' });
    else if (room === 0) rejected.push({ name: file.name, reason: 'tooMany' });
    else {
      accepted.push(file);
      room--;
    }
  }
  return { accepted, rejected };
}

/** One line per reason, the first file named when there is only one (the tray's notice). */
export function summarizeRejections(rejected: readonly TrayRejection[]): Array<{ reason: TrayRejectionReason; name: string; count: number }> {
  const out: Array<{ reason: TrayRejectionReason; name: string; count: number }> = [];
  for (const r of rejected) {
    const found = out.find((o) => o.reason === r.reason);
    if (found) found.count++;
    else out.push({ reason: r.reason, name: r.name, count: 1 });
  }
  return out;
}

export type FileBadge = 'pdf' | 'archive' | 'sheet' | 'slides' | 'document' | 'code' | 'image' | 'video' | 'audio' | 'generic';

const BADGES: ReadonlyArray<[FileBadge, readonly string[]]> = [
  ['pdf', ['pdf']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']],
  ['sheet', ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers']],
  ['slides', ['ppt', 'pptx', 'odp', 'key']],
  ['document', ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub']],
  ['code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'html', 'css', 'xml', 'yml', 'yaml', 'toml', 'ini', 'lua']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'avif', 'ico', 'psd']],
  ['video', ['mp4', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'm4v']],
  ['audio', ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'wma']],
];

/** The lower-case extension of a file name, without the dot ('' when it has none). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The icon of a file card, from its kind and then its extension. */
export function fileBadge(name: string, kind: AttachmentKind): FileBadge {
  if (kind !== 'file') return kind;
  const ext = extensionOf(name);
  for (const [badge, exts] of BADGES) if (exts.includes(ext)) return badge;
  return 'generic';
}

/** The name with its extension kept visible when it must be cut ("relatório-mui….pdf"). */
export function middleEllipsis(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = extensionOf(name);
  const tail = ext && ext.length <= 8 ? `.${ext}` : '';
  const keep = Math.max(1, max - tail.length - 1);
  return `${name.slice(0, keep)}…${tail}`;
}

/** 0–100, whole numbers, for the progress bars and their labels. */
export function percent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : Math.floor(progress * 100);
}
