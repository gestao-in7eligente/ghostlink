-- System bots (spec 2026-10-02-ghost-dj-design.md §2; the bots module, src/bots/). Never edit after merge.
-- bots.system: NULL for a bot someone created; the kind of a bot the server creates itself
--   ('ghost-dj': the Ghost DJ). A system bot has no connection code (its token_hash is the hash
--   of random bytes nobody ever saw), cannot be regenerated nor deleted, does not count toward
--   the bot limit, and its interactions are answered inside the server.
ALTER TABLE bots ADD COLUMN system TEXT CHECK (system IS NULL OR length(system) BETWEEN 1 AND 32);

CREATE UNIQUE INDEX bots_system ON bots(system) WHERE system IS NOT NULL;
