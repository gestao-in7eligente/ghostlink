// `upload.begin` → `POST /upload?u=<uploadToken>` (main spec §4, §5.2, §7): one single-use token
// per file, valid for 60 s, for each purpose. A new purpose (the server icon: `icon`) adds its
// schema to the union below and its answer to the server's upload hub.
import { z } from 'zod';
import { ATTACHMENT_LIMITS } from './attachments.js';
import { avatarUploadBeginSchema } from './avatar.js';
import { entityIdSchema } from './chat.js';

/** `upload.begin` for a channel attachment (spec 2026-10-01-anexos §2): ATTACH_FILES, VIEW_CHANNEL and SEND_MESSAGES there. */
export const attachmentUploadBeginSchema = z.strictObject({
  purpose: z.literal('attachment'),
  channelId: entityIdSchema,
  /** The name as picked; the server stores it cleaned (cleanFileName). */
  name: z.string().min(1).max(ATTACHMENT_LIMITS.nameInputMax),
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AttachmentUploadBegin = z.infer<typeof attachmentUploadBeginSchema>;

export const uploadBeginSchema = z.discriminatedUnion('purpose', [avatarUploadBeginSchema, attachmentUploadBeginSchema]);
export type UploadBegin = z.infer<typeof uploadBeginSchema>;
export type UploadPurpose = UploadBegin['purpose'];

export interface UploadBeginResult {
  /** Single use, valid for 60 s: `POST /upload?u=<uploadToken>`. */
  uploadToken: string;
  /** Attachments only: the id the file will have, for msg.send's attachmentIds. */
  fileId?: string;
}

/** The body of a successful attachment `POST /upload`. */
export interface AttachmentUploadResult {
  fileId: string;
}
