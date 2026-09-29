-- Text, roles and moderation (spec §5–§7). Owned by the text module; never edit after merge.
-- users.removed_at, users.rejoin_blocked_until and users.nickname_norm already exist (001_init.sql).
-- PRAGMA secure_delete = ON is set on every connection by Db (spec §7).

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0 CHECK (color BETWEEN 0 AND 16777215),
  permissions INTEGER NOT NULL DEFAULT 0 CHECK (permissions >= 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  hoist INTEGER NOT NULL DEFAULT 0 CHECK (hoist IN (0, 1)),
  mentionable INTEGER NOT NULL DEFAULT 0 CHECK (mentionable IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  -- 'admin' marks the seeded Admin role, which an old owner receives on transfer (spec §3.3).
  system_tag TEXT
) STRICT;

CREATE UNIQUE INDEX roles_single_default ON roles(is_default) WHERE is_default = 1;

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
) STRICT;

CREATE INDEX user_roles_role ON user_roles(role_id);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  topic TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  user_limit INTEGER NOT NULL DEFAULT 0 CHECK (user_limit >= 0), -- 0 = no limit
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE channel_allowed_roles (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, role_id)
) STRICT;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reply_to_id INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  client_msg_id TEXT,
  -- Mentions that took effect (JSON arrays of ids, and a flag), for display.
  mention_users TEXT NOT NULL DEFAULT '[]',
  mention_roles TEXT NOT NULL DEFAULT '[]',
  mention_everyone INTEGER NOT NULL DEFAULT 0 CHECK (mention_everyone IN (0, 1)),
  UNIQUE (user_id, client_msg_id)
) STRICT;

CREATE INDEX messages_channel ON messages(channel_id, id DESC);
CREATE INDEX messages_user ON messages(user_id);

CREATE TABLE reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
) STRICT;

CREATE INDEX reactions_user ON reactions(user_id);

CREATE TABLE mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
) STRICT;

CREATE INDEX mentions_user ON mentions(user_id, message_id);

CREATE TABLE read_states (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
) STRICT;
