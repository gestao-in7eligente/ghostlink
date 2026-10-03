-- Enterprise and the company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md
-- §1, §2; src/enterprise/, src/companyHermes/). Never edit after merge.
-- enterprise: one row. license: the GLE1.… text the owner pasted (checked when pasted, at start and
--   every hour); edition: the result, written by the enterprise module and read by the bot handshake
--   (auth/botAuth.ts: the company Hermes needs an Enterprise server).
CREATE TABLE enterprise (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license TEXT CHECK (license IS NULL OR length(license) <= 4096),
  set_by TEXT,
  set_at INTEGER,
  edition TEXT NOT NULL DEFAULT 'normal' CHECK (edition IN ('normal', 'enterprise'))
) STRICT;

-- company_hermes: one row. bot_id: the bot marked as the company Hermes (NULL once deleted: the
--   settings stay for the next one). deepseek_key / openrouter_key: the company's AI keys, secrets:
--   they go only to that bot's session (hermes.config), never back to an app, never to the logs; the
--   server's erase empties this table like every other. settings: HermesSettings as JSON. version:
--   bumped by every hermes.update. report / report_at: the last hermes.report, JSON.
CREATE TABLE company_hermes (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT UNIQUE REFERENCES bots(user_id) ON DELETE SET NULL,
  deepseek_key TEXT CHECK (deepseek_key IS NULL OR length(deepseek_key) <= 512),
  openrouter_key TEXT CHECK (openrouter_key IS NULL OR length(openrouter_key) <= 512),
  settings TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  report_at INTEGER
) STRICT;
