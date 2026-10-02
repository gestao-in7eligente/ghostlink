-- Bots (spec 2026-10-02-bots-design.md §2; the bots module, src/bots/). Never edit after merge.
-- A bot is a member (users row, is_bot = 1) with no Ed25519 identity: its public_key is a
-- random 19-byte marker ('bot' + 16 bytes) that no 32-byte hello key can ever equal.
-- bots holds only the SHA-256 of the connection token's secret. Deleting a bot deletes its
-- bots row and marks the member removed; its messages stay (messages.user_id still points at it).
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1));

CREATE TABLE bots (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  -- The slash commands of commands.set, as validated JSON (BotCommand[]).
  commands TEXT NOT NULL DEFAULT '[]'
) STRICT;

-- A bot's public answer to a slash command: the interaction's id, who used it and which command.
ALTER TABLE messages ADD COLUMN interaction_id TEXT;
ALTER TABLE messages ADD COLUMN interaction_user_id TEXT;
ALTER TABLE messages ADD COLUMN interaction_command TEXT;
