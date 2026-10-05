-- The bot's settings (spec 2026-10-02-pagina-do-bot-design.md "Servidor"; the bots module, src/bots/).
-- Never edit after merge.
-- bots.description: the bot's "Sobre" (bot.update, or the bot itself with bot.setDescription),
--   cleaned like a message, at most 1000 characters; '' when none.
-- bots.last_seen_at: when its last session opened or closed (ms, the server's clock); NULL: it
--   never connected.
ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000);
ALTER TABLE bots ADD COLUMN last_seen_at INTEGER;

-- One row per interaction.invoke that reached the bot (id = the interaction's id); answered = 1
-- once the bot's first interaction.respond (a reply or a defer) arrived. Rows older than 7 days
-- are deleted (when the bot gets a new one, and every hour); deleting the bot deletes its rows.
CREATE TABLE bot_command_uses (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1))
) STRICT;

CREATE INDEX bot_command_uses_bot_at ON bot_command_uses(bot_id, at);
