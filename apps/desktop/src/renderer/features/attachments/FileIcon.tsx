import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, type LucideIcon } from 'lucide-react';
import { fileBadge, type AttachmentKind, type FileBadge } from './attachmentModel.js';

const ICONS: Readonly<Record<FileBadge, LucideIcon>> = {
  pdf: FileText,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  slides: Presentation,
  document: FileText,
  code: FileCode,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  generic: File,
};

/** The icon of a file: its kind, then its extension (PDF, ZIP, spreadsheet…). */
export function FileIcon({ name, kind, size = 30 }: { name: string; kind: AttachmentKind; size?: number }) {
  const Icon = ICONS[fileBadge(name, kind)];
  return <Icon size={size} strokeWidth={1.6} aria-hidden="true" />;
}
