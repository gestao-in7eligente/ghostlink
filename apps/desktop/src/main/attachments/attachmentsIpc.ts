// The attachment channels (spec 2026-10-01-anexos §4). ipc.ts registers them with the same
// sender check → zod → handler pipeline as every other channel. The bytes are only shaped and
// capped here; main checks them again against the server's own limit before sending.
import { z } from 'zod';
import { ATTACHMENT_LIMITS } from '@ghostlink/shared';
import { ATTACHMENT_IPC_MAX_BYTES, DM_FILE_URL_PREFIX, SERVER_FILE_URL_PREFIX } from '../../shared/attachmentTypes.js';
import { IPC, type AttachmentsIpcChannel, type IpcArgs, type IpcReturn } from '../../shared/ipcTypes.js';
import type { SaveResult, UploadResult } from '../../shared/attachmentTypes.js';

/** A file name as upload.begin takes it (the server cleans it, main spec §7); longer ones are refused. */
export const ATTACHMENT_NAME_MAX = ATTACHMENT_LIMITS.nameInputMax;

export interface AttachmentsIpcDeps {
  upload(uploadId: string, serverId: string, channelId: string, name: string, bytes: Uint8Array): Promise<UploadResult>;
  save(src: string, name: string): Promise<SaveResult>;
}

const name = z.string().min(1).max(ATTACHMENT_NAME_MAX);

export const ATTACHMENTS_IPC_ARG_SCHEMAS: { readonly [C in AttachmentsIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.attachmentsUpload]: z.tuple([
    z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    z.string().min(1).max(64),
    z.string().regex(/^[A-Z2-7]{26}$/),
    name,
    z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= ATTACHMENT_IPC_MAX_BYTES),
  ]),
  [IPC.attachmentsSave]: z.tuple([
    z
      .string()
      .max(512)
      .refine((src) => src.startsWith(SERVER_FILE_URL_PREFIX) || src.startsWith(DM_FILE_URL_PREFIX)),
    name,
  ]),
};

type AttachmentsHandlers = { [C in AttachmentsIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createAttachmentsIpcHandlers(deps: AttachmentsIpcDeps | undefined): AttachmentsHandlers {
  const attachments = () => {
    if (!deps) throw new Error('Attachments are not wired');
    return deps;
  };
  return {
    [IPC.attachmentsUpload]: (uploadId, serverId, channelId, fileName, bytes) => attachments().upload(uploadId, serverId, channelId, fileName, bytes),
    [IPC.attachmentsSave]: (src, fileName) => attachments().save(src, fileName),
  };
}
