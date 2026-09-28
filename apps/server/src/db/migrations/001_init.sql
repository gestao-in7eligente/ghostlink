-- Milestone 1 schema (spec §7). Later milestones add 002_*.sql and never edit this file.

CREATE TABLE server_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  icon_file_id TEXT,
  join_mode TEXT NOT NULL DEFAULT 'invite' CHECK (join_mode IN ('open', 'password', 'invite')),
  password_hash TEXT,
  owner_user_id TEXT,
  setup_code_hash TEXT,
  public_addresses TEXT NOT NULL DEFAULT '[]',
  max_members INTEGER NOT NULL DEFAULT 100 CHECK (max_members > 0),
  upload_limit_mb INTEGER NOT NULL DEFAULT 25,
  storage_quota_mb INTEGER NOT NULL DEFAULT 10240,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  nickname_norm TEXT NOT NULL UNIQUE,
  avatar_file_id TEXT,
  locale TEXT,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip TEXT,
  removed_at INTEGER,
  rejoin_blocked_until INTEGER
) STRICT;

CREATE TABLE bans (
  user_id TEXT PRIMARY KEY,
  public_key BLOB,
  ip TEXT,
  reason TEXT,
  banned_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX bans_public_key ON bans(public_key);
CREATE INDEX bans_ip ON bans(ip) WHERE ip IS NOT NULL;

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) STRICT;
