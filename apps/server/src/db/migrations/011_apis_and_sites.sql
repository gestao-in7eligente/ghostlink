-- The API tab and the Sites category (spec 2026-10-03-aba-api-e-sites-design.md; src/companyHermes/,
-- src/sites/). Never edit after merge.
-- company_hermes_keys: every API key of the company Hermes, by the environment variable the plugin sets
--   (DEEPSEEK_API_KEY, ELEVENLABS_API_KEY, one of the owner's own…). Secrets: only in hermes.config,
--   never back to an app (the last 4 only), never to the logs. name: what the API tab shows. At most 30
--   (the server checks). The server's erase empties it like every other table.
CREATE TABLE company_hermes_keys (
  env_var TEXT PRIMARY KEY CHECK (length(env_var) BETWEEN 3 AND 64),
  name TEXT NOT NULL CHECK (length(name) <= 256),
  value TEXT NOT NULL CHECK (length(value) <= 512)
) STRICT;
-- v0.6's two keys move here; their old columns are emptied (secure_delete overwrites the pages).
INSERT INTO company_hermes_keys (env_var, name, value)
  SELECT 'DEEPSEEK_API_KEY', 'DeepSeek', deepseek_key FROM company_hermes WHERE id = 1 AND deepseek_key IS NOT NULL;
INSERT INTO company_hermes_keys (env_var, name, value)
  SELECT 'OPENROUTER_API_KEY', 'OpenRouter', openrouter_key FROM company_hermes WHERE id = 1 AND openrouter_key IS NOT NULL;
UPDATE company_hermes SET deepseek_key = NULL, openrouter_key = NULL;

-- sites: the Sites category (Enterprise only). A site is a text channel with a name and a bare domain.
--   Deleting the channel deletes the site; removing the site leaves the channel. At most 50 (the server checks).
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) <= 256),
  domain TEXT NOT NULL UNIQUE CHECK (length(domain) <= 253),
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;
