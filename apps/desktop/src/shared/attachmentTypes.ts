// Attachments (spec 2026-10-01-anexos §4): the renderer hands files to main by IPC and loads
// them back through app:// routes; it never sees a path, a server URL or the fileToken.
// Shared by main, preload and renderer (type-only for the preload, no runtime dependency).

/** Where the renderer loads a server attachment from (main's app:// route, attachments/fileRoute.ts). */
export const SERVER_FILE_URL_PREFIX = 'app://ghostlink/_file/';
/** Where the renderer loads a direct-message file from (the DM engine's route). */
export const DM_FILE_URL_PREFIX = 'app://ghostlink/_dmfile/';

/** app://ghostlink/_file/<serverId>/<fileId>. */
export function serverFileUrl(serverId: string, fileId: string): string {
  return `${SERVER_FILE_URL_PREFIX}${encodeURIComponent(serverId)}/${encodeURIComponent(fileId)}`;
}

/** app://ghostlink/_dmfile/<hash>. */
export function dmFileUrl(hash: string): string {
  return `${DM_FILE_URL_PREFIX}${hash}`;
}

/**
 * The largest file the renderer may hand to main in one IPC call, whatever a server allows (a
 * server may allow up to 2 GB): the tray holds bigger files back with the same message as for
 * the server's limit.
 */
export const ATTACHMENT_IPC_MAX_BYTES = 500 * 1024 * 1024;

/** An upload's progress, pushed by main while the bytes go out (IPC_EVENTS.attachmentProgress). */
export interface UploadProgressEvent {
  /** The id the renderer gave the upload. */
  uploadId: string;
  /** Bytes the server has taken so far. */
  sent: number;
  total: number;
}

export interface UploadResult {
  /** The server's file id, for msg.send's attachmentIds. */
  fileId: string;
}

export interface SaveResult {
  /** False when the person closed the dialog. */
  saved: boolean;
  /** The name it was saved under (never the folder), or null. */
  fileName: string | null;
}

/** window.ghostlink.attachments. */
export interface AttachmentsApi {
  /**
   * Sends one file to the server on screen (`serverId`) for `channelId`: upload.begin, then
   * POST /upload, with progress through onProgress. Resolves with the file id for msg.send.
   */
  upload(uploadId: string, serverId: string, channelId: string, name: string, bytes: Uint8Array): Promise<UploadResult>;
  /**
   * "Baixar": always asks where to save (the system dialog), then writes the file there. Never
   * opens it. `src` is an attachment URL the page shows (SERVER_FILE_URL_PREFIX or DM_FILE_URL_PREFIX).
   */
  save(src: string, name: string): Promise<SaveResult>;
  onProgress(cb: (event: UploadProgressEvent) => void): () => void;
}
