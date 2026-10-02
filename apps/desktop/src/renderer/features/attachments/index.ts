// The shared attachment pieces (spec 2026-10-01-anexos §4), for server channels and DMs alike:
// data in (AttachmentView, TrayItem, UploadView), callbacks out. Nothing here knows where the
// files live; each side maps its records and passes its own download when it needs one.
export {
  IMAGE_BOX,
  MAX_ATTACHMENTS,
  addToTray,
  fitImage,
  formatSize,
  kindFromMime,
  mbToBytes,
  mosaicRows,
  type AttachmentKind,
  type AttachmentView,
  type TrayItem,
  type TrayLimits,
  type TrayRejection,
  type UploadView,
} from './attachmentModel.js';
export { AttachmentList } from './AttachmentList.js';
export { AttachmentTray } from './AttachmentTray.js';
export { DownloadButton, saveAttachment, useDownload, type DownloadHandler } from './DownloadButton.js';
export { FileIcon } from './FileIcon.js';
export { DropOverlay, TrayNotice, pastedFiles, useFileDrop, useFilePicker, useTray, type PickedFile, type TrayFile } from './filePicking.js';
export { Lightbox } from './Lightbox.js';
export { UploadProgress } from './UploadProgress.js';
