-- Attachments (spec 2026-10-01-anexos-design.md §2; main spec §7 "Arquivos"). Never edit after merge.
-- One row per stored file; the bytes are data/files/<disk_name> (a random name). The row is
-- written by POST /upload with message_id NULL; msg.send links it (same transaction as the
-- message) and sets position, its place among the message's files. An upload no message
-- used within 1 h is deleted. Deleting the message deletes its rows (text module); deleting
-- the channel cascades. upload_limit_mb and storage_quota_mb already exist in server_meta.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  disk_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX files_message ON files(message_id, position) WHERE message_id IS NOT NULL;
CREATE INDEX files_unused ON files(created_at) WHERE message_id IS NULL;
CREATE INDEX files_channel ON files(channel_id);
