# The API Tab and the Sites Category — Implementation Plan (v0.7.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> The owner wants speed: after Task 0 and the contract (Task 1), **five tracks run in parallel** in the same worktree. Each track works test-first and ends with `npm run lint`, `npm run typecheck` and **its own** test files green; CI is the gate (no repeated full local runs). Commit only your own files (`git add <paths>`, never `-A`); another track commits in the same worktree, so retry once if `index.lock` is busy.

**Goal:** the company Hermes's page gets a 6th tab, **API**, where the owner keeps every API key the Hermes uses (a catalog plus "Outra API"), replacing the settings' "Chaves de IA"; and an Enterprise server gets a **SITES** category below BOTS, where the owner and the page's role register the company's sites (name, address, text channel), so the Hermes posts each action, its errors and a daily summary in each site's channel.

**Architecture:** the server keeps every key in one table by environment variable (`company_hermes_keys`, the two v0.6 keys moved there) and sends them, with the site list, only in `hermes.config`. A new `sites` server module stores sites as rows pointing at existing text channels (categories are not stored: the sidebar shows a site's channel under SITES instead of "Canais de texto", so history and permissions never move). The desktop adds the API tab to v0.6.3's tabbed page and a SITES section to the sidebar. The Hermes plugin 1.2 puts the keys in its process environment, writes a generated `ghostlink-sites` skill and keeps one Hermes cron job for the 23:00 summary.

**Tech Stack:** TypeScript (Node 24, `node:sqlite`, zod 4), React/Electron renderer (zustand), Python 3.11+ plugin (aiohttp, cryptography, ruamel.yaml), vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-aba-api-e-sites-design.md` (pt-BR). Sections 1, 2, 4 and 5 are code (Tasks 1–I); section 3 is the runbook (Task R), done by the main session **with the owner** after the release. It builds on `2026-10-02-enterprise-e-hermes-da-empresa-design.md` (plan `2026-10-02-enterprise-e-hermes-da-empresa.md`), `2026-10-03-pagina-do-hermes-da-empresa-design.md` (v0.6.2) and `2026-10-03-pagina-larga-e-abas-do-hermes-design.md` (v0.6.3, the page's tabs).

**Branch:** `v0.7.0-dev`, worktree `.claude/worktrees/v070`, cut from main at v0.6.2. Run every command from the worktree root.

---

## Rules for every task (owner, 2026-10-02: the repository is public)

1. **No key, token or secret in any committed file, test fixture or doc.** Tests build obviously fake values at run time (`` `sk-test-${tag}-${randomBytes(12).toString('hex')}` ``), and never print a secret.
2. **Keys live only in the GhostLink server's database and in the Hermes gateway process's memory.** The server never returns a key to an app (only its last 4 characters) and never logs one; the plugin never writes one to disk (no `.env`, no `config.yaml`, no skill, no cron job). GhostLink sends them again on every connection.
3. **`GHOSTLINK_COMPANY=true` gating stays:** without it the plugin ignores every `hermes.*` event, sets no variable, writes no skill and no cron job.
4. **Plugin 1.2 keeps accepting a 1.1-shaped `hermes.config`** (no `apis`, no `sites`, two keys), and **a 0.7 server keeps working with plugin 1.1** (it ignores the new fields).
5. **Environment variable names** for "Outra API" follow the spec's deny rules (`apiEnvVarProblem`, Task 1); the plugin applies the same rule again before touching its environment.
6. Never log request payloads, `hermes.config`, or key values; error messages never echo input.

## What Hermes Agent's public source says (checked 2026-10-03, `NousResearch/hermes-agent@3251a18`)

Links are to commit `3251a180f01ad21ae059862997307bf75f3e3f0a`. **Which image the TC Hermes runs is uncertain.** Its pinned digest (`sha256:dcbb1d20…`, the Trismegisto's) matches none of the 36 published tags (`v2026.x.y`, `latest`, `main`), so it is an older `latest`/`main` build. Its log line `capability_check plugin=ghostlink capability=tools.override decision=deny` exists from v2026.8.13 on (commit `b088535c78`), so the image is at least that version. Every fact below also holds on v2026.8.13 unless its row says otherwise; Task R3 checks the rest on the image itself.

| # | Topic | Fact | Source |
|---|---|---|---|
| 1 | Provider ids and key variables | `model.provider` takes `deepseek` (`DEEPSEEK_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), **`openai-api`** (`OPENAI_API_KEY`), `anthropic` (`ANTHROPIC_API_KEY` or `ANTHROPIC_TOKEN`) and `gemini` (`GOOGLE_API_KEY` or `GEMINI_API_KEY`), among others (`nous`, `xai`, …). **`openai` is a legacy alias of OpenRouter**, so GhostLink's id for OpenAI is `openai-api`. `google` and `claude` are aliases too. | [`hermes_cli/auth.py#L181`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/auth.py#L181), [`#L192-L193`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/auth.py#L192-L193), [`#L217-L218`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/auth.py#L217-L218), [`#L225`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/auth.py#L225); [`plugins/model-providers/openrouter/__init__.py#L208`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/plugins/model-providers/openrouter/__init__.py#L208); [`hermes_cli/providers.py#L116`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/providers.py#L116); [`website/docs/reference/cli-commands.md#L130`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/website/docs/reference/cli-commands.md#L130) |
| 1 | Keys hidden from the terminal | The terminal's child processes lose every provider key in the registry. They also lose a fixed list (`OPENAI_*`, `ANTHROPIC_*`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `GATEWAY_ALLOWED_USERS`, …) and every Hermes variable of category `tool`. **`ELEVENLABS_API_KEY` is one of those** (Hermes's own voice tools read it in-process). A name Hermes does not know (`GROK_API_KEY`, `YUNWU_API_KEY`, `MACROL_MCP_KEY`, the owner's own) reaches the skills' scripts, unless a plugin manifest declares it with a secret-like suffix. `env_passthrough` can never re-allow a blocked name. | [`tools/environments/local_env_policy.py#L19-L90`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/environments/local_env_policy.py#L19-L90), [`#L93-L174`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/environments/local_env_policy.py#L93-L174); [`tools/environments/local.py#L242-L273`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/environments/local.py#L242-L273); [`hermes_cli/config_defaults.py#L2965-L2968`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/config_defaults.py#L2965-L2968) |
| 1 | Key tests that spend no tokens | OpenAI: `GET https://api.openai.com/v1/models` (Bearer). Anthropic: `GET https://api.anthropic.com/v1/models` (`x-api-key`, `anthropic-version: 2023-06-01`). Gemini: `GET https://generativelanguage.googleapis.com/v1beta/models` (`x-goog-api-key`; a bad key answers `400 API_KEY_INVALID`, not 401). DeepSeek: `GET https://api.deepseek.com/models` (Bearer). OpenRouter: `GET https://openrouter.ai/api/v1/key` (Bearer). | [OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list), [Anthropic](https://platform.claude.com/docs/en/api/models-list), [Gemini models](https://ai.google.dev/api/models) and [its key header](https://ai.google.dev/gemini-api/docs/api-key), [Gemini errors](https://ai.google.dev/gemini-api/docs/troubleshooting), [DeepSeek](https://api-docs.deepseek.com/api/list-models), [OpenRouter](https://openrouter.ai/docs/api/reference/limits) |
| 2 | MCP headers | `mcp_servers.<name>: {url, headers, transport, timeout, connect_timeout, enabled}`. Header values take `${VAR}` and `${env:VAR}`. They are resolved from the profile's secret scope, then `os.environ`, each time the config is loaded for discovery or reload. `$HERMES_HOME/.env` overrides the process environment there. Before `main`, an unset variable is sent literally. | [`website/docs/reference/mcp-config-reference.md#L16-L62`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/website/docs/reference/mcp-config-reference.md#L16-L62); [`tools/mcp_tool_config.py#L129-L130`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/mcp_tool_config.py#L129-L130), [`#L441-L466`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/mcp_tool_config.py#L441-L466); [`tools/mcp_tool_common.py#L77-L82`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/mcp_tool_common.py#L77-L82); [`agent/secret_scope.py#L219-L247`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/agent/secret_scope.py#L219-L247); [`hermes_cli/env_loader.py#L461`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/env_loader.py#L461) |
| 2 | MCP connects at start; no plugin reconnect | The gateway discovers MCP servers **before** it starts the platforms, so a key GhostLink sends later misses that connect. Reconnecting is the chat command `/reload-mcp`, implemented inside the gateway runner: shutdown, re-probe, discover, then refresh every cached agent's tools. It goes through internal modules that were split and renamed in 2026-09. The reconcile tick (v2026.9.14+) only adds or removes servers; it never reconnects one whose header changed. No plugin API reconnects a server. **→ the spec's fallback: `MACROL_MCP_KEY` is a Railway variable of the TC Hermes.** | [`gateway/run.py#L5959-L5970`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/gateway/run.py#L5959-L5970); [`gateway/run_turn.py#L2572-L2611`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/gateway/run_turn.py#L2572-L2611); [`gateway/run_profile_reconcile.py#L336-L363`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/gateway/run_profile_reconcile.py#L336-L363); [`tools/mcp_tool_discovery.py#L633-L662`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/mcp_tool_discovery.py#L633-L662) |
| 3 | Posting in a channel | The model has had **no `send_message` tool** since v2026.6.x. The send engine stays for `hermes send` and cron: it takes `platform:ref` targets, plugin platforms included, and calls the adapter's `send(chat_id, content)`. A plugin adds tools with `ctx.register_tool(name, toolset, schema, handler, check_fn=…, is_async=…, override=False)`. **A new name without `override=True` needs no capability.** Tools in the toolset named after a plugin platform join its implicit `hermes-<platform>` bundle. The TC Hermes's `tools.override … deny` line is an `override=True` registration being refused; capabilities are granted in `plugins.entries.<id>.granted_capabilities` (or `allow_tool_override: true`). A sync handler runs on the agent's thread (`registry.dispatch`). The docs ask plugins not to add a general `send_message` twin. That is policy, not code: GhostLink's tool posts only to the registered sites' channels. | [`toolsets.py#L200`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/toolsets.py#L200), [`#L355-L372`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/toolsets.py#L355-L372); [`tools/send_message_tool.py#L43-L52`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/send_message_tool.py#L43-L52), [`#L306-L322`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/send_message_tool.py#L306-L322), [`#L554`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/send_message_tool.py#L554); [`hermes_cli/plugins.py#L456-L497`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/plugins.py#L456-L497); [`hermes_cli/plugin_capabilities.py#L28-L47`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/plugin_capabilities.py#L28-L47), [`#L130-L147`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/plugin_capabilities.py#L130-L147); [`tools/registry.py#L893-L915`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/registry.py#L893-L915); [`website/docs/developer-guide/adding-platform-adapters.md#L238`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/website/docs/developer-guide/adding-platform-adapters.md#L238) |
| 4 | Cron | Jobs live in `$HERMES_HOME/cron/jobs.json` (`{"jobs": [...]}`). They are written through `cron.jobs.create_job(prompt, schedule, name=, deliver=, enabled_toolsets=, …)`, `remove_job(id)` and `list_jobs(include_disabled=True)`, which take an in-process lock plus `.jobs.lock`. The file is re-read on every 60-second tick, so no restart is needed. Writing `jobs.json` by hand bypasses the lock, and an edit can be lost. Schedules follow `HERMES_TIMEZONE`, then `timezone:` in `config.yaml`, else the server's local time (`hermes_time.now()`). `deliver` takes `local`, `origin`, `platform:chat_id`, … A final answer of `[SILENT]` delivers nothing. A job's `enabled_toolsets` sets its tools. | [`cron/jobs.py#L86`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L86), [`#L286-L337`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L286-L337), [`#L1812-L1943`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L1812-L1943), [`#L1981`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L1981), [`#L2301`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L2301), [`#L3319-L3321`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/jobs.py#L3319-L3321); [`hermes_time.py#L1-L5`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_time.py#L1-L5), [`#L146-L149`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_time.py#L146-L149); [`cron/scheduler.py#L490-L512`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/scheduler.py#L490-L512), [`#L550-L580`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/scheduler.py#L550-L580); [`cron/scheduler_delivery.py#L609-L690`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/cron/scheduler_delivery.py#L609-L690) |
| 5 | Skills at run time | Skills live in `$HERMES_HOME/skills/<category>/<name>/SKILL.md`. `skills_list` and `skill_view` rescan (mtime check, 30-second cache), so a new folder is usable without a restart. The system prompt's skill index is cached in memory and misses a new folder until `agent.prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=True)` runs; new sessions then list it. `/reload-skills` does not clear it. `ctx.register_skill` makes a read-only `ghostlink:<name>` skill that stays out of the index, so the plugin writes a real folder instead. | [`hermes_constants.py#L1195-L1197`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_constants.py#L1195-L1197); [`website/docs/developer-guide/creating-skills.md#L45-L80`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/website/docs/developer-guide/creating-skills.md#L45-L80); [`tools/skills_tool.py#L34-L39`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/skills_tool.py#L34-L39), [`#L184-L226`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/tools/skills_tool.py#L184-L226); [`agent/prompt_builder.py#L1217-L1225`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/agent/prompt_builder.py#L1217-L1225), [`#L1520-L1532`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/agent/prompt_builder.py#L1520-L1532); [`agent/skill_commands.py#L528-L543`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/agent/skill_commands.py#L528-L543); [`hermes_cli/plugins.py#L1055-L1088`](https://github.com/NousResearch/hermes-agent/blob/3251a180f01ad21ae059862997307bf75f3e3f0a/hermes_cli/plugins.py#L1055-L1088) |

## Decisions where the spec left room

1. **Categories are not stored.** The sidebar groups channels by type (`ChannelSidebar.tsx`: "Canais de texto", "Canais de voz") and BOTS is its own section. "Moving a channel to Sites" is a `sites` row pointing at the channel: the sidebar shows that channel under SITES instead of "Canais de texto". Its messages, read states and permissions never change. Removing the site deletes only the row; deleting the channel deletes its site (`ON DELETE CASCADE`).
2. **Who manages sites:** the owner and the members of the company Hermes page's viewer role (v0.6.2's `viewerRoleId`), only while the server is Enterprise (`FORBIDDEN`, then `ENTERPRISE_REQUIRED`). "Criar canal novo" creates a public text channel on their behalf even without `MANAGE_CHANNELS` (the spec gives that right to the role). **Editar** changes the name and the address; another channel means removing the site and registering it again. A site whose channel a person cannot see is `NOT_FOUND` for them, even for the role.
3. **"Os canais que já existem com nome de site viram os sites":** the register dialog lists the text channels whose name is a bare domain and that are not sites yet, with **Cadastrar como sites** (one `site.create` per channel, name = address = the channel's name). Nothing converts by itself (a guess could take a channel that is not a site). The owner runs it once in TC Flag (Task R5).
4. **All keys in one table by variable.** `company_hermes_keys (env_var, name, value)`; `011_apis_and_sites.sql` moves v0.6's two keys there and empties their old columns. `hermes.update` keeps `keys` (now the five AI providers, by provider id) and gains `apis` (any other key, by variable, `null` deletes). An app before 0.7 keeps sending `keys.deepseek` and works.
5. **`hermes.config` grows, nothing is renamed:** `keys` (the five AIs), `apis` (the others, `{ VAR: value }`) and `sites` (`[{ id, name, domain, channelId }]`). Plugin 1.1 reads only `keys.deepseek` / `keys.openrouter` and the fields it knows (`company.py` iterates its own `PROVIDER_ENV`), so the server needs no switch. Plugin 1.2 reads a missing `apis` / `sites` as empty.
6. **The report stays compatible both ways.** A 0.6 server's `hermesReportSchema` is strict with exactly two key results, so plugin 1.2 sends the three new ones only when the welcome's `features` has `enterpriseApis`; a 0.7 server reads a missing result as `unchecked`.
7. **The API tab** is the page's 6th tab, owner only, after Memória: `['overview', 'skills', 'access', 'memory', 'api', 'commands']`. It reads and saves through the owner's `HermesState` (`hermes.update`), as the settings did. On a server without `enterpriseApis` it shows DeepSeek and OpenRouter only, with "Atualize o servidor para cadastrar outras APIs". The settings lose "Chaves de IA"; "Modelos" points to the API tab.
8. **Variable names:** `^[A-Z][A-Z0-9_]{2,63}$` (the spec's "maiúsculas, números e `_`, 3 a 64", starting with a letter because a shell variable cannot start with a digit), then the suffix rule (it must end in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`) and the deny lists of Task 1 (`apiEnvVarProblem`; the catalog is checked before them). In `apis` a catalog AI variable is refused (it goes in `keys`); the catalog's other APIs take their catalog name; a variable of the owner's needs a name.
9. **Limits:** 30 keys in all (the AIs' included), 50 sites, 60 site changes per person per minute (a bulk "Cadastrar como sites" sends one per channel).
10. **Sites go to members as `sites.state { sites }`**, each person getting only the sites whose channel they see, and in the welcome (`sites`) on an Enterprise server. A normal server sends none: the app shows no SITES and every channel back under "Canais de texto"; the rows stay for a renewal.
11. **A site change bumps `hermes.config`'s version** (the settings' "aplicando…" line follows it), and so does a site lost with its channel.
12. **Addresses:** `normalizeSiteDomain` turns a pasted `https://Es.Site.com/` into `es.site.com`; the server takes only the bare form; a path, port, query, user or password is refused ("sem caminho e sem segredo"). Unique per server.
13. **AI providers use Hermes's ids** (fact 1): `deepseek`, `openrouter`, `openai-api`, `anthropic`, `gemini`. The plugin sets `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`, and tests each key on its free listing (a bad Gemini key answers 400).
14. **Posting in a site's channel** (fact 3): no Hermes tool posts to a chosen channel, so plugin 1.2 registers two tools of its own. They go in the `ghostlink` toolset, under new names and without `override`, so they need no capability.
    - `ghostlink_site_post(site, kind, text)`: kind `action`, `error` or `summary`, posted with ✅, ⚠️ or 📋, and only in a registered site's channel.
    - `ghostlink_site_activity()`: the day's ✅/⚠️ posts by the Hermes in each site's channel, read back with `msg.history`. There is no activity file.
    - `check_fn` hides both unless company mode is on and there is a site.
15. **The generated skill** (fact 5) is `$HERMES_HOME/skills/ghostlink/ghostlink-sites/SKILL.md`. It holds the sites (name, address, channel name) and says when to call the tools; it never holds a key.
    - It is rewritten only when its text changes and removed with the last site.
    - Hermes's skill index cache is cleared when the folder appears or goes.
    - It also shows in the Skills tab, where the owner can switch it off like any other.
16. **`MACROL_MCP_KEY`** (fact 2) takes the spec's fallback. It leaves the catalog, because a row whose key cannot reach the MCP would mislead, and lives in a Railway variable of the TC Hermes (Task R4). Any variable already in the gateway's environment at start (Railway, s6, Hermes's `.env`) belongs to the operator: an `apis` key never replaces or removes it.
17. **The daily summary** (fact 4) is one Hermes cron job, `ghostlink-sites-resumo`, created and replaced through `cron.jobs`, never by editing `jobs.json`.
    - It runs at 23:00 São Paulo time, written in Hermes's own timezone (on Railway's UTC that is `0 2 * * *`; Brazil has had no daylight saving time since 2019).
    - It has `deliver: local` and `enabled_toolsets: ["ghostlink"]`.
    - Its prompt reads the day's activity, posts a 📋 summary in each site that had activity and ends with `[SILENT]`. A site without activity gets nothing. That costs one AI call a day.
18. **Which keys the skills' scripts see** (fact 1): Hermes itself hides the AI keys, and also `ELEVENLABS_API_KEY`, one of its own tool keys that its voice tools still use. `GROK_API_KEY`, `YUNWU_API_KEY` and the owner's own variables reach the scripts. The README says so. The spec's "as outras ficam visíveis" holds for every key except ElevenLabs.

## File map

| Owner | Files |
|---|---|
| Task 1 (contract) | `packages/shared/src/{companyHermes,index}.ts`, `packages/shared/src/sites.ts` (new), `packages/shared/test/{hermesApis,sites}.test.ts` (new), `apps/server/src/db/migrations/011_apis_and_sites.sql` (new), `apps/server/test/migration011.test.ts` (new), `apps/server/src/companyHermes/{store,index}.ts`, `apps/server/src/sites/index.ts` (stub), `apps/server/src/defaultModules.ts`, `apps/server/test/helpers/botClient.ts` (new), `apps/server/test/companyHermes.test.ts` (two fixture lines), `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/renderer/features/bots/hermes/hermesModel.ts` (one line), `apps/desktop/src/renderer/i18n/sites.{pt-BR,en}.ts` (new), `apps/desktop/src/renderer/i18n/{pt-BR,en}.ts` (spread), `apps/desktop/test/renderer/{i18n,enterprise,hermesModel}.test.ts` (fixtures, one import) |
| Track A — keys on the server | `apps/server/src/companyHermes/apis.ts` (new), `apps/server/src/companyHermes/index.ts` (`hermes.update`, features); test `apps/server/test/companyHermes.test.ts` (one new describe) |
| Track B — sites on the server | `apps/server/src/sites/**`, `apps/server/src/text/index.ts` (`createTextChannel`), `apps/server/src/text/handlers/channels.ts` (`insertChannel`); test `apps/server/test/sites.test.ts` (new) |
| Track C — the API tab | `apps/desktop/src/renderer/features/bots/hermes/{apiModel.ts,ApiTab.tsx}` (new), `apps/desktop/src/renderer/features/bots/hermes/{HermesPage,HermesTabs}.tsx`, `apps/desktop/src/renderer/features/bots/hermes/hermesPageModel.ts`, `apps/desktop/src/renderer/features/bots/hermes/hermes.module.css`, `apps/desktop/src/renderer/i18n/enterprise.{pt-BR,en}.ts`; tests `apps/desktop/test/renderer/apiModel.test.ts` (new), `apps/desktop/test/renderer/hermesPageModel.test.ts` (one assertion) |
| Track D — the SITES category | `apps/desktop/src/renderer/features/sites/**` (new), `apps/desktop/src/renderer/stores/enterprise.ts`, `apps/desktop/src/renderer/layout/ChannelSidebar.tsx`, `apps/desktop/src/renderer/layout/TextChannelRow.tsx` (new, moved out of the sidebar), `apps/desktop/src/renderer/features/channelMenu/{ChannelMenu.tsx,channelMenuModel.ts}`, `apps/desktop/src/renderer/i18n/sites.{pt-BR,en}.ts`; tests `apps/desktop/test/renderer/siteModel.test.ts` (new), `apps/desktop/test/renderer/{enterprise,channelMenu}.test.ts` (one test each) |
| Track E — plugin 1.2 | `integrations/hermes-agent/ghostlink/{company.py,sites.py (new),adapter.py,plugin.yaml}`, `integrations/hermes-agent/README.md`, `integrations/hermes-agent/test/{company_check.py,company.test.ts,sites_check.py (new),sites.test.ts (new)}` |
| Integration (main session) | `integrations/hermes-agent/test/{company_e2e.py,company-hermes.test.ts}`, `apps/server/src/MODULES.md`, `docs/checklist-teste.md`, `release-notes/0.7.0.md`, version bump |

Tracks A–E depend only on the contract. Track D's sidebar works against the contract's `sites.state` / welcome shape before Track B lands; Track C's tab works against the contract's `HermesState.apis`.

---

## Task 0: Merge main (v0.6.3) into v0.7.0-dev — main session

v0.6.3 (spec `2026-10-03-pagina-larga-e-abas-do-hermes-design.md`) is merged into main as `90fb88f` plus the fix `8215ea6`. It changed only the desktop: `BotPage.tsx`, `hermes/HermesPage.tsx` (five tabs; `query` / `filter` lifted into the page), `hermes/hermesPageModel.ts` (`hermesPageTabs`, `pageSkillRows`, `searchSkills`, `filterSkills`), `hermes.module.css`, the enterprise i18n and `hermesPageModel.test.ts`. This plan's API tab is a 6th entry of `hermesPageTabs` and a 6th panel in `HermesPage.tsx`, so it must be built **on that code**.

- [ ] **Step 1: Merge**

```bash
git fetch origin
git log --oneline origin/main -3   # expect 90fb88f "v0.6.3: wider bot pages and tabs…" (or later)
git merge --no-ff origin/main -m "Merge main (v0.6.3) into v0.7.0-dev"
```

Expected: a clean merge (v0.7.0-dev holds only the spec and this plan beyond v0.6.2).

- [ ] **Step 2: Check what this plan builds on**

```bash
ls apps/server/src/db/migrations
grep -n "export function hermesPageTabs" -A 3 apps/desktop/src/renderer/features/bots/hermes/hermesPageModel.ts
grep -n "tab === 'memory'\|tab === 'commands'" apps/desktop/src/renderer/features/bots/hermes/HermesPage.tsx
```

Expected: the last migration is `010_hermes_viewer_role.sql` (so this plan's is `011_apis_and_sites.sql`; if main added one, use the next free number everywhere this plan says `011`); `hermesPageTabs(owner)` returns `['overview', 'skills', 'access', 'memory', 'commands']` for the owner; `HermesPage.tsx` renders one panel per `tab === …`.

- [ ] **Step 3: Push nothing yet.** The tracks start after Task 1.

---

## Task 1: The contract — one agent, before the tracks

**Files:** see the File map's first row.

- [ ] **Step 1: Write the failing shared tests**

`packages/shared/test/hermesApis.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HERMES_API_CATALOG, HERMES_LIMITS, HERMES_PROVIDERS, HERMES_PROVIDER_ENV, apiEnvVarProblem, hermesReportSchema, hermesUpdateSchema } from '../src/index.js';

// Made for the test, obviously not a key.
const FAKE = 'fake-key-0001';

describe('the API tab: catalog and variable names (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('lists the five AIs by the variable Hermes reads, then the other APIs', () => {
    expect(HERMES_API_CATALOG.map((a) => a.envVar)).toEqual([
      'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY', 'GROK_API_KEY', 'YUNWU_API_KEY',
    ]);
    expect(HERMES_API_CATALOG.filter((a) => a.provider !== null).map((a) => a.provider)).toEqual([...HERMES_PROVIDERS]);
    for (const p of HERMES_PROVIDERS) expect(HERMES_API_CATALOG.find((a) => a.provider === p)?.envVar).toBe(HERMES_PROVIDER_ENV[p]);
  });

  it.each(['MINHA_API_KEY', 'SERPAPI_KEY', 'ABC', 'WP_PASS_2', 'X'.repeat(64)])('takes %s for "Outra API"', (name) => {
    expect(apiEnvVarProblem(name)).toBeNull();
  });

  it.each(['', 'AB', 'my_key', '1KEY', '_KEY', 'MY-KEY', 'MY KEY', 'X'.repeat(65)])('refuses the shape of %j', (name) => {
    expect(apiEnvVarProblem(name)).toBe('format');
  });

  it.each(['PATH', 'HOME', 'SHELL', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'TERMINAL_ENV', 'GATEWAY_ALLOWED_USERS', 'HERMES_HOME', 'GHOSTLINK_BOT', 'GHOSTLINK_COMPANY'])(
    'refuses the system, Hermes or GhostLink variable %s',
    (name) => expect(apiEnvVarProblem(name)).toBe('reserved'),
  );

  it('a catalog variable is not "Outra API"', () => {
    expect(apiEnvVarProblem('ELEVENLABS_API_KEY')).toBe('catalog');
    expect(apiEnvVarProblem('DEEPSEEK_API_KEY')).toBe('catalog');
  });

  it('hermes.update takes keys for the five AIs and 1 to 30 API changes', () => {
    expect(hermesUpdateSchema.safeParse({ keys: { gemini: FAKE, deepseek: null } }).success).toBe(true);
    expect(hermesUpdateSchema.safeParse({ apis: { MINHA_API_KEY: { name: 'Minha API', value: FAKE }, YUNWU_API_KEY: null } }).success).toBe(true);
    expect(hermesUpdateSchema.safeParse({ apis: { my_key: null } }).success).toBe(false);
    expect(hermesUpdateSchema.safeParse({ apis: {} }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: HERMES_LIMITS.maxApis + 1 }, (_, i) => [`API_${i}_KEY`, null]));
    expect(hermesUpdateSchema.safeParse({ apis: many }).success).toBe(false);
  });

  it("a plugin 1.1's report (two key results) still parses; the other AIs read as unchecked", () => {
    const status = { model: null, fallback: null, keys: { deepseek: 'ok', openrouter: 'missing' }, unsupported: null, envOverride: [] };
    const parsed = hermesReportSchema.parse({ appliedVersion: 1, skills: [], memory: { company: [], people: [] }, status });
    expect(parsed.status.keys).toEqual({ deepseek: 'ok', openrouter: 'missing', 'openai-api': 'unchecked', anthropic: 'unchecked', gemini: 'unchecked' });
  });
});
```

`packages/shared/test/sites.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSiteDomain, siteCreateSchema, siteUpdateSchema } from '../src/index.js';

describe('site addresses (spec 2026-10-03-aba-api-e-sites §2 "Endereço")', () => {
  it.each([
    ['es.profetacristao.com', 'es.profetacristao.com'],
    ['  https://Es.ProfetaCristao.com/ ', 'es.profetacristao.com'],
    ['http://loja.tcflag.com.br', 'loja.tcflag.com.br'],
    ['tcflag.com.br.', 'tcflag.com.br'],
  ])('%j is the domain %s', (raw, domain) => {
    expect(normalizeSiteDomain(raw)).toBe(domain);
  });

  it.each([
    'es.profetacristao.com/blog', 'https://user:senha@site.com', 'site.com:8080', 'site.com?token=x', 'localhost',
    '127.0.0.1', 'site..com', '-site.com', 'site-.com', 'meu site.com', 'ftp://site.com', '',
  ])('%j is not a bare domain', (raw) => {
    expect(normalizeSiteDomain(raw)).toBeNull();
  });

  it('the server takes only the bare form', () => {
    const id = 'A'.repeat(26);
    expect(siteCreateSchema.safeParse({ name: 'Profeta Cristão ES', domain: 'es.profetacristao.com', channelId: null }).success).toBe(true);
    expect(siteCreateSchema.safeParse({ name: 'Loja', domain: 'loja.tcflag.com.br', channelId: id }).success).toBe(true);
    expect(siteCreateSchema.safeParse({ name: 'X', domain: 'https://es.profetacristao.com', channelId: null }).success).toBe(false);
    expect(siteUpdateSchema.safeParse({ id }).success).toBe(false);
    expect(siteUpdateSchema.safeParse({ id, domain: 'Es.Site.com' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- packages/shared/test/hermesApis.test.ts packages/shared/test/sites.test.ts`
Expected: FAIL — `HERMES_API_CATALOG`, `apiEnvVarProblem`, `normalizeSiteDomain` and the rest are not exported.

- [ ] **Step 3: `packages/shared/src/sites.ts`**

```ts
// The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2, `enterpriseSites`): in an Enterprise
// server a site is a text channel with a name and a bare domain, shown under SITES below BOTS. The
// channel keeps its history and its permissions; removing the site leaves the channel.
//
// Requests (the owner and the company Hermes page's viewer role, FORBIDDEN for anyone else; then
// ENTERPRISE_REQUIRED on a normal server):
//   - `site.create { name, domain, channelId }` → { site }: `channelId` a text channel the person sees
//     that is not a site yet, or null for a new public text channel named after the domain.
//   - `site.update { id, name?, domain? }` → { site }.
//   - `site.delete { id }` → {}: the channel stays and goes back to "Canais de texto".
//   NOT_FOUND: a site or channel the person cannot see. BAD_REQUEST: 50 sites, a domain in use, a channel
//   that already is a site, a voice channel, an empty name.
// Event `sites.state { sites }` to each member when the sites they see change (only those whose channel
//   they see); their welcome carries `sites` on an Enterprise server.
// To the company Hermes: hermes.config's `sites`, all of them (companyHermes.ts).
import { z } from 'zod';
import { entityIdSchema } from './chat.js';

/** welcome.features (v0.7.0): the Sites category. */
export const FEATURE_ENTERPRISE_SITES = 'enterpriseSites';

export const SITE_LIMITS = {
  maxSites: 50,
  /** Graphemes, after sanitizeLabel. */
  nameMax: 64,
  domainMax: 253,
  /** site.create / update / delete per person per minute ("Cadastrar como sites" sends one per channel). */
  changesPerMinute: 60,
} as const;

export interface Site {
  id: string;
  name: string;
  /** A bare domain, lowercase: "es.profetacristao.com". */
  domain: string;
  channelId: string;
}

/** A site as hermes.config carries it: no key, ever. */
export type HermesSite = Site;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A pasted address as a bare domain, or null when it is not one: " https://Es.ProfetaCristao.com/ " →
 * "es.profetacristao.com". A path, a query, a port, a user or a password ("sem caminho e sem segredo"),
 * spaces, an IP address and a single label are refused.
 */
export function normalizeSiteDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length === 0 || s.length > SITE_LIMITS.domainMax) return null;
  const labels = s.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TOP_LABEL.test(labels.at(-1)!)) return null;
  return s;
}

// ---- server side: strict ----

const siteName = z.string().min(1).max(256); // cut to SITE_LIMITS.nameMax graphemes by sanitizeLabel
const siteDomain = z
  .string()
  .max(SITE_LIMITS.domainMax)
  .refine((d) => normalizeSiteDomain(d) === d, 'not a bare lowercase domain');

export const siteCreateSchema = z.strictObject({ name: siteName, domain: siteDomain, channelId: entityIdSchema.nullable() });
export const siteUpdateSchema = z
  .strictObject({ id: entityIdSchema, name: siteName.optional(), domain: siteDomain.optional() })
  .refine((p) => p.name !== undefined || p.domain !== undefined, 'nothing to update');
export const siteDeleteSchema = z.strictObject({ id: entityIdSchema });

// ---- client side: lenient ----

export const siteSchemaClient: z.ZodType<Site> = z.object({
  id: z.string().max(64),
  name: z.string().max(256),
  domain: z.string().max(300),
  channelId: z.string().max(64),
});
export const sitesSchemaClient: z.ZodType<Site[]> = z.array(siteSchemaClient).max(200).catch([]);
/** The `sites.state` event. */
export const sitesStateSchemaClient = z.object({ sites: sitesSchemaClient });
```

`packages/shared/src/index.ts`, after `export * from './companyHermes.js';`:

```ts
export * from './sites.js';
```

- [ ] **Step 4: `packages/shared/src/companyHermes.ts`**

4a. At the end of the header comment (after the "Only the owner may regenerate…" line), add:

```ts
//
// The API tab (spec 2026-10-03-aba-api-e-sites-design.md §1, `enterpriseApis`, v0.7.0):
//   - `hermes.update` takes `keys` for the five AI providers and `apis`: any other API key by its
//     environment variable (the catalog's, or one of the owner's own named after apiEnvVarProblem's
//     rules), `null` to delete it; at most 30 keys in all.
//   - `hermes.config` carries `keys` (the five), `apis` ({ VAR: key }) and `sites` (sites.ts). Plugin 1.1
//     reads only keys.deepseek / keys.openrouter and ignores the rest.
//   - HermesState shows each as its last 4: `keys` by provider, `apis` for the others.
```

4b. Below `FEATURE_ENTERPRISE_HERMES_VIEW`:

```ts
/** welcome.features (v0.7.0): the API tab (`apis` in hermes.update, the five AI providers). */
export const FEATURE_ENTERPRISE_APIS = 'enterpriseApis';
```

4c. Replace the two provider lines (`export const HERMES_PROVIDERS = …` and `export type HermesProvider = …`) with:

```ts
/** The AI providers GhostLink keeps keys for, by the id Hermes's `model.provider` takes (plan "Facts" 1). */
export const HERMES_PROVIDERS = ['deepseek', 'openrouter', 'openai-api', 'anthropic', 'gemini'] as const;
export type HermesProvider = (typeof HERMES_PROVIDERS)[number];
/** The two a plugin 1.1 knows: its report's `status.keys` has only these. */
export const HERMES_PROVIDERS_V1 = ['deepseek', 'openrouter'] as const satisfies readonly HermesProvider[];
```

4d. In `HERMES_LIMITS`, after `keyMax: 512,`:

```ts
  /** API keys in all, the five AIs' included (spec 2026-10-03 §1 "Limite"). */
  maxApis: 30,
  /** An "Outra API" display name, in graphemes. */
  apiNameMax: 64,
```

4e. After `HERMES_DEFAULT_SETTINGS`, add the catalog and the variable rule:

```ts
/** The variable Hermes reads each AI provider's key from (plan "Facts" 1). */
export const HERMES_PROVIDER_ENV: Readonly<Record<HermesProvider, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-api': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export const HERMES_PROVIDER_NAMES: Readonly<Record<HermesProvider, string>> = {
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  'openai-api': 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

/** An API of the API tab's catalog. */
export interface HermesApiCatalogEntry {
  envVar: string;
  name: string;
  /** The AI provider it keys (Models tab, key test); null: another API, never tested. */
  provider: HermesProvider | null;
}

/**
 * Spec §1 "Catálogo": the AIs, then the others (their variables are what the TC Hermes's skills read).
 * MACROL_MCP_KEY is not here: Hermes connects MCP servers before GhostLink sends any key (plan decision 16).
 */
export const HERMES_API_CATALOG: readonly HermesApiCatalogEntry[] = [
  ...HERMES_PROVIDERS.map((provider) => ({ envVar: HERMES_PROVIDER_ENV[provider], name: HERMES_PROVIDER_NAMES[provider], provider })),
  { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', provider: null },
  { envVar: 'GROK_API_KEY', name: 'Grok (xAI)', provider: null },
  { envVar: 'YUNWU_API_KEY', name: 'Yunwu', provider: null },
];

/** "Outra API": a letter, then letters, digits and `_`; 3 to 64 in all (a variable cannot start with a digit). */
export const API_ENV_VAR = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Variables an API key must never replace (spec §1 "Nomes recusados"): the system's, the Python and
 * Node runtimes', TLS and proxies, Hermes's and GhostLink's. integrations/hermes-agent/ghostlink/company.py
 * keeps the same two lists (ENV_DENIED_NAMES / ENV_DENIED_PREFIXES): change both together.
 */
export const API_ENV_DENIED_NAMES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TERM', 'TZ',
  'HOSTNAME', 'LOGNAME', 'MAIL', 'IFS', 'ENV', 'CDPATH', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'EDITOR', 'VISUAL',
  'PAGER', 'DISPLAY', 'SSH_AUTH_SOCK', 'VIRTUAL_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY',
];
export const API_ENV_DENIED_PREFIXES: readonly string[] = [
  'LD_', 'DYLD_', 'PYTHON', 'NODE_', 'NPM_', 'SSL_', 'REQUESTS_CA', 'CURL_CA', 'GIT_', 'PIP_', 'UV_', 'LC_', 'XDG_',
  // Hermes reads its terminal backend (TERMINAL_*) and the gateway's allowlists (GATEWAY_*) from the environment.
  'BASH_', 'S6_', 'RAILWAY_', 'TERMINAL_', 'GATEWAY_', 'HERMES_', 'GHOSTLINK_',
];

export type ApiEnvVarProblem = 'format' | 'reserved' | 'catalog';

/** Why a variable cannot be an "Outra API" (null: it can). 'catalog': it has its own row. */
export function apiEnvVarProblem(envVar: string): ApiEnvVarProblem | null {
  if (!API_ENV_VAR.test(envVar)) return 'format';
  if (API_ENV_DENIED_NAMES.includes(envVar) || API_ENV_DENIED_PREFIXES.some((p) => envVar.startsWith(p))) return 'reserved';
  if (HERMES_API_CATALOG.some((a) => a.envVar === envVar)) return 'catalog';
  return null;
}
```

4f. `HermesConfig` becomes:

```ts
/** `hermes.config`: everything the Hermes should be, keys included. A secret: never logged. */
export interface HermesConfig extends HermesSettings {
  /** Bumped by every hermes.update and every site change; the report names the one applied. */
  version: number;
  /** The AI keys by provider (plugin 1.1 reads deepseek and openrouter only). */
  keys: Record<HermesProvider, string | null>;
  /** v0.7.0: every other API key, by its environment variable. */
  apis: Record<string, string>;
  /** v0.7.0: the company's sites (no key). */
  sites: HermesSite[];
}
```

with `import type { HermesSite } from './sites.js';` next to the `entityIdSchema` import.

4g. Add, after `HermesMemoryDelete`:

```ts
/** An API key other than the five AIs', as the owner's app sees it (v0.7.0). */
export interface HermesApiInfo {
  envVar: string;
  name: string;
  last4: string;
}
```

and in `HermesState`, after `keys`:

```ts
  /** v0.7.0: the other API keys saved, by variable, each as its last 4 ([] from a server before 0.7.0). */
  apis: HermesApiInfo[];
```

4h. In `HermesUpdatePayload`, after `keys?`:

```ts
  /** v0.7.0: other API keys by variable: a key (and, for a variable of the owner's own, its name), or null to delete. */
  apis?: Record<string, { name?: string; value: string } | null>;
```

4i. Server schemas. Replace the `hermesUpdateSchema` definition with:

```ts
const keyChange = keyValue.nullable().optional();
const apiEnvVar = z.string().regex(API_ENV_VAR);
const apiName = z.string().min(1).max(256); // cut to HERMES_LIMITS.apiNameMax graphemes by the server

export const hermesUpdateSchema = z
  .strictObject({
    keys: z.strictObject({ deepseek: keyChange, openrouter: keyChange, 'openai-api': keyChange, anthropic: keyChange, gemini: keyChange }).optional(),
    apis: z
      .record(apiEnvVar, z.strictObject({ name: apiName.optional(), value: keyValue }).nullable())
      .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= HERMES_LIMITS.maxApis, '1 to 30 changes')
      .optional(),
    models: hermesModelsSchema.optional(),
    disabledSkills: z.array(skillName).max(HERMES_LIMITS.maxSkills).optional(),
    access: hermesAccessSchema.optional(),
    viewerRoleId: entityIdSchema.nullable().optional(),
  })
  .refine(
    (p) =>
      p.keys !== undefined || p.apis !== undefined || p.models !== undefined || p.disabledSkills !== undefined || p.access !== undefined || p.viewerRoleId !== undefined,
    'nothing to update',
  );
```

and, in `hermesReportSchema`, the `keys` line of `status` with:

```ts
    // Plugin 1.1 reports the first two only (decision 6).
    keys: z.strictObject({
      deepseek: keyStatus,
      openrouter: keyStatus,
      'openai-api': keyStatus.default('unchecked'),
      anthropic: keyStatus.default('unchecked'),
      gemini: keyStatus.default('unchecked'),
    }),
```

4j. Client schemas. Replace the `keys` line of `hermesReportSchemaClient`'s `status` and its `.catch(…)` default:

```ts
      keys: z
        .object({ deepseek: keyStatusClient, openrouter: keyStatusClient, 'openai-api': keyStatusClient, anthropic: keyStatusClient, gemini: keyStatusClient })
        .catch(UNCHECKED_KEYS),
```

```ts
    .catch({ model: null, fallback: null, keys: UNCHECKED_KEYS, unsupported: null, envOverride: [] }),
```

with, above `hermesReportSchemaClient`:

```ts
const UNCHECKED_KEYS = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, 'unchecked'])) as Record<HermesProvider, HermesKeyStatus>;
const NO_KEYS = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, null])) as Record<HermesProvider, null>;
```

and in `hermesStateSchemaClient` replace the `keys` line and add `apis`:

```ts
  keys: z.object({ deepseek: lastFour, openrouter: lastFour, 'openai-api': lastFour, anthropic: lastFour, gemini: lastFour }).catch(NO_KEYS),
  // A server before 0.7.0 has none.
  apis: z.array(z.object({ envVar: z.string().max(64), name: z.string().max(256), last4: z.string().max(8) })).max(200).catch([]),
```

(`envOverride: z.array(z.enum(HERMES_PROVIDERS)).max(4)` in the client schema becomes `.max(HERMES_PROVIDERS.length)`.)

- [ ] **Step 5: Run the shared tests**

Run: `npm test -- packages/shared/test/hermesApis.test.ts packages/shared/test/sites.test.ts`
Expected: PASS.

- [ ] **Step 6: The migration and its test**

`apps/server/src/db/migrations/011_apis_and_sites.sql`:

```sql
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
```

`apps/server/test/migration011.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, loadMigrations } from '../src/db/database.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('011_apis_and_sites.sql', () => {
  it("moves v0.6's AI key to company_hermes_keys and empties the old columns", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghostlink-m011-'));
    dirs.push(dir);
    const db = new Db(join(dir, 'ghostlink.db'));
    const all = loadMigrations();
    db.migrate(all.slice(0, 10));
    const deepseek = `fake-deepseek-${Date.now()}`; // made now, never a real key
    db.run('INSERT INTO company_hermes (id, deepseek_key, openrouter_key) VALUES (1, ?, NULL)', deepseek);
    db.migrate(all);
    expect(db.all('SELECT env_var, name, value FROM company_hermes_keys')).toEqual([{ env_var: 'DEEPSEEK_API_KEY', name: 'DeepSeek', value: deepseek }]);
    expect(db.get('SELECT deepseek_key, openrouter_key FROM company_hermes WHERE id = 1')).toEqual({ deepseek_key: null, openrouter_key: null });
    db.close();
  });
});
```

Run: `npm test -- apps/server/test/migration011.test.ts`
Expected: PASS.

- [ ] **Step 7: `apps/server/src/companyHermes/store.ts` reads and writes the new table**

Replace the whole file with:

```ts
import {
  HERMES_API_CATALOG,
  HERMES_DEFAULT_SETTINGS,
  HERMES_PROVIDERS,
  HERMES_PROVIDER_ENV,
  hermesReportSchema,
  hermesSettingsSchema,
  type HermesProvider,
  type HermesReport,
  type HermesSettings,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';

interface Row {
  bot_id: string | null;
  settings: string;
  version: number;
  report: string | null;
  report_at: number | null;
  viewer_role_id: string | null;
}

/** A key other than the five AIs' (v0.7.0), by the variable the plugin sets. */
export interface HermesApiRecord {
  envVar: string;
  name: string;
  /** A secret: only for hermes.config. */
  value: string;
}

export interface HermesRecord {
  botId: string | null;
  /** Secrets: only for hermes.config, never for an answer or a log. */
  keys: Record<HermesProvider, string | null>;
  /** v0.7.0: the other API keys (secrets too), by variable. */
  apis: HermesApiRecord[];
  settings: HermesSettings;
  version: number;
  report: HermesReport | null;
  reportAt: number | null;
  /** The role that sees the company Hermes's page (010_hermes_viewer_role.sql); never in hermes.config. */
  viewerRoleId: string | null;
}

/** An `apis` change already checked (companyHermes/apis.ts): a name and a key, or null to delete. */
export type HermesApisChange = Record<string, { name: string; value: string } | null>;

export interface HermesStoreChange extends Pick<HermesUpdatePayload, 'keys' | 'models' | 'disabledSkills' | 'access'> {
  apis?: HermesApisChange;
}

const PROVIDER_BY_ENV = new Map<string, HermesProvider>(HERMES_PROVIDERS.map((p) => [HERMES_PROVIDER_ENV[p], p]));
const catalogName = (envVar: string): string => HERMES_API_CATALOG.find((a) => a.envVar === envVar)?.name ?? envVar;

function json(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The single company_hermes row (009_enterprise.sql) and its keys (011_apis_and_sites.sql), read fresh each time. */
export class HermesStore {
  constructor(private readonly db: Db) {
    db.run('INSERT OR IGNORE INTO company_hermes (id) VALUES (1)');
  }

  load(): HermesRecord {
    const r = this.db.get<Row>('SELECT bot_id, settings, version, report, report_at, viewer_role_id FROM company_hermes WHERE id = 1')!;
    const keys = Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, null])) as Record<HermesProvider, string | null>;
    const apis: HermesApiRecord[] = [];
    for (const k of this.db.all<{ env_var: string; name: string; value: string }>('SELECT env_var, name, value FROM company_hermes_keys ORDER BY env_var')) {
      const provider = PROVIDER_BY_ENV.get(k.env_var);
      if (provider) keys[provider] = k.value;
      else apis.push({ envVar: k.env_var, name: k.name, value: k.value });
    }
    const settings = hermesSettingsSchema.safeParse(json(r.settings));
    const report = hermesReportSchema.safeParse(json(r.report));
    return {
      botId: r.bot_id,
      keys,
      apis,
      settings: settings.success ? settings.data : HERMES_DEFAULT_SETTINGS,
      version: Number(r.version),
      report: report.success ? report.data : null,
      reportAt: r.report_at === null ? null : Number(r.report_at),
      viewerRoleId: r.viewer_role_id,
    };
  }

  setBot(botId: string): void {
    this.db.run('UPDATE company_hermes SET bot_id = ? WHERE id = 1', botId);
  }

  setViewerRole(roleId: string | null): void {
    this.db.run('UPDATE company_hermes SET viewer_role_id = ? WHERE id = 1', roleId);
  }

  /** Merges a change of what the Hermes gets (keys, other APIs, models, skills, access) and bumps the version. */
  update(p: HermesStoreChange): void {
    const current = this.load();
    for (const provider of HERMES_PROVIDERS) {
      const value = p.keys?.[provider];
      const envVar = HERMES_PROVIDER_ENV[provider];
      if (value !== undefined) this.setKey(envVar, catalogName(envVar), value);
    }
    for (const [envVar, change] of Object.entries(p.apis ?? {})) this.setKey(envVar, change?.name ?? envVar, change?.value ?? null);
    const settings: HermesSettings = {
      models: p.models ?? current.settings.models,
      disabledSkills: p.disabledSkills ?? current.settings.disabledSkills,
      access: p.access ?? current.settings.access,
    };
    this.db.run('UPDATE company_hermes SET settings = ?, version = version + 1 WHERE id = 1', JSON.stringify(settings));
  }

  /** A change outside these settings (the sites) that the Hermes must get as a new hermes.config. */
  bumpVersion(): void {
    this.db.run('UPDATE company_hermes SET version = version + 1 WHERE id = 1');
  }

  saveReport(report: HermesReport, at: number): void {
    this.db.run('UPDATE company_hermes SET report = ?, report_at = ? WHERE id = 1', JSON.stringify(report), at);
  }

  private setKey(envVar: string, name: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM company_hermes_keys WHERE env_var = ?', envVar);
    else this.db.run('INSERT INTO company_hermes_keys (env_var, name, value) VALUES (?, ?, ?) ON CONFLICT (env_var) DO UPDATE SET name = excluded.name, value = excluded.value', envVar, name, value);
  }
}
```

- [ ] **Step 8: `apps/server/src/companyHermes/index.ts`: the keys' read side and the sites' hooks**

8a. Imports: add `HERMES_PROVIDERS` to the `@ghostlink/shared` import and `type HermesSite` to its types.

8b. The module interface becomes:

```ts
export interface CompanyHermesModule extends ServerModule {
  readonly name: typeof COMPANY_HERMES_MODULE_NAME;
  /** v0.7.0 (sites): the owner, or a member of the page's viewer role while the server is Enterprise. */
  seesPage(userId: string): boolean;
  /** v0.7.0: where hermes.config's `sites` come from (the sites module, from its init). */
  useSites(source: () => HermesSite[]): void;
  /** v0.7.0: the sites changed: a new hermes.config version goes to the company Hermes, the owner's state follows. */
  sitesChanged(): void;
}
```

8c. Under `const sentViews = …`:

```ts
  /** hermes.config's sites; none until the sites module registers (tests without it). */
  let sitesSource: () => HermesSite[] = () => [];
```

8d. In `stateOf`, replace the `keys:` line and add `apis` after it:

```ts
      keys: Object.fromEntries(HERMES_PROVIDERS.map((p) => [p, last4(r.keys[p])])) as HermesState['keys'],
      apis: r.apis.map(({ envVar, name, value }) => ({ envVar, name, last4: value.slice(-4) })),
```

8e. In `sendConfig`, replace the `const event…` line with:

```ts
    const config: HermesConfig = {
      version: r.version,
      keys: r.keys,
      apis: Object.fromEntries(r.apis.map((a) => [a.envVar, a.value])),
      sites: sitesSource(),
      ...r.settings,
    };
    const event: ServerEvent = { t: 'hermes.config', d: config };
```

8f. In `'hermes.update'`, replace `if (forHermes) s.store.update(change);` with (Track A adds `apis` here):

```ts
        if (forHermes) s.store.update({ keys: change.keys, models: change.models, disabledSkills: change.disabledSkills, access: change.access });
```

8g. In the returned module object, after `handlers,`:

```ts
    seesPage(userId) {
      const s = need();
      return userId === ownerId(s) || roleHolders(s, s.store.load()).includes(userId);
    },

    useSites(source) {
      sitesSource = source;
    },

    sitesChanged() {
      const s = need();
      s.store.bumpVersion();
      sendConfig(s);
      announce(s);
    },
```

- [ ] **Step 9: The sites module's stub, registered**

`apps/server/src/sites/index.ts`:

```ts
import type { ServerModule } from '../modules.js';

export const SITES_MODULE_NAME = 'sites';

/** The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2). Register after companyHermes. Track B fills it. */
export interface SitesModule extends ServerModule {
  readonly name: typeof SITES_MODULE_NAME;
}

export function createSitesModule(): SitesModule {
  return { name: SITES_MODULE_NAME };
}
```

`apps/server/src/defaultModules.ts`: import it and add `createSitesModule(),` right after `createCompanyHermesModule(),`; extend the order comment: "The sites after the company Hermes (who manages them is the page's role; hermes.config carries them)."

- [ ] **Step 10: A shared test helper for bot sessions**

`apps/server/test/helpers/botClient.ts` (the handshake `companyHermes.test.ts` has inline, for the new tests):

```ts
import { PROTOCOL, parseBotConnectionCode, type ErrorCode } from '@ghostlink/shared';
import { wrapClient, type TextClient, type TextFixture } from '../text/helpers.js';
import { connectRaw } from './testClient.js';

/** A bot's handshake with its connection code (as in bots.test.ts): its client, or the refusal. */
export async function connectBot(fx: TextFixture, code: string): Promise<{ client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode }> {
  const parsed = parseBotConnectionCode(code)!;
  const raw = await connectRaw(fx.t.server, { pin: parsed.serverKeyId });
  raw.send({ t: 'hello', d: { protocol: PROTOCOL.current, bot: parsed.token, client: 'hermes-test/0.0.0' } });
  const m = await raw.next();
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  const welcome = m.d as { self: { userId: string; nickname: string } } & Record<string, unknown>;
  return { client: wrapClient(raw, welcome, { userId: welcome.self.userId, seed: new Uint8Array(32), nickname: welcome.self.nickname }) };
}
```

- [ ] **Step 11: Fixtures the wider types touch**

- `apps/server/test/companyHermes.test.ts`: in `report()`, `keys: { deepseek: 'ok', openrouter: 'missing', 'openai-api': 'missing', anthropic: 'missing', gemini: 'missing' }`; in "keys go only to the company Hermes", `expect(state.keys).toEqual({ deepseek: { last4: key.slice(-4) }, openrouter: null, 'openai-api': null, anthropic: null, gemini: null });`.
- `apps/desktop/test/renderer/enterprise.test.ts` (`hermes`) and `apps/desktop/test/renderer/hermesModel.test.ts` (`state()`, `report`): every `keys` object gets `'openai-api'`, `anthropic` and `gemini` (`null` in a state, `'missing'` in a report), and each `HermesState` gets `apis: []`.
- `apps/desktop/src/renderer/features/bots/hermes/hermesModel.ts`: `export const PROVIDER_NAMES: Record<HermesProvider, string> = HERMES_PROVIDER_NAMES;` (import it from `@ghostlink/shared`).

Run: `npm run typecheck`
Expected: no error. (If it lists another fixture typed `HermesState` / `HermesReport`, fix it the same way.)

- [ ] **Step 12: The desktop's request list and the sites i18n namespace**

`apps/desktop/src/main/ipc.ts`, after the line with `'hermes.view',`:

```ts
  // The Sites category (v0.7.0): the owner and the company Hermes page's role.
  'site.create', 'site.update', 'site.delete',
```

`apps/desktop/src/renderer/i18n/sites.pt-BR.ts`:

```ts
// The Sites category (v0.7.0, spec 2026-10-03-aba-api-e-sites-design.md §2). Spread into pt-BR.ts;
// sites.en.ts must have exactly the same keys. Track D adds the rest.
export const sites = {
  'sites.section': 'Sites',
};

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const SITES_SAME_IN_BOTH = ['sites.section'] as const;
```

`apps/desktop/src/renderer/i18n/sites.en.ts`:

```ts
// The Sites category (v0.7.0).
import type { sites as sitesPt } from './sites.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const sites: Record<keyof typeof sitesPt, string> = {
  'sites.section': 'Sites',
};
```

Spread them: in `pt-BR.ts` `import { sites } from './sites.pt-BR.js';` and `...sites,` after `...enterprise,`; in `en.ts` the same with `./sites.en.js`. In `apps/desktop/test/renderer/i18n.test.ts` import `SITES_SAME_IN_BOTH` from `../../src/renderer/i18n/sites.pt-BR.js` and add `...SITES_SAME_IN_BOTH` to `sameOnPurpose`.

- [ ] **Step 13: Check and commit**

Run: `npm run lint && npm run typecheck && npm test -- packages/shared/test/hermesApis.test.ts packages/shared/test/sites.test.ts apps/server/test/migration011.test.ts apps/server/test/companyHermes.test.ts apps/desktop/test/renderer/i18n.test.ts apps/desktop/test/renderer/enterprise.test.ts apps/desktop/test/renderer/hermesModel.test.ts`
Expected: PASS.

```bash
git add packages/shared/src/companyHermes.ts packages/shared/src/sites.ts packages/shared/src/index.ts packages/shared/test/hermesApis.test.ts packages/shared/test/sites.test.ts apps/server/src/db/migrations/011_apis_and_sites.sql apps/server/test/migration011.test.ts apps/server/src/companyHermes/store.ts apps/server/src/companyHermes/index.ts apps/server/src/sites/index.ts apps/server/src/defaultModules.ts apps/server/test/helpers/botClient.ts apps/server/test/companyHermes.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/renderer/features/bots/hermes/hermesModel.ts apps/desktop/src/renderer/i18n/sites.pt-BR.ts apps/desktop/src/renderer/i18n/sites.en.ts apps/desktop/src/renderer/i18n/pt-BR.ts apps/desktop/src/renderer/i18n/en.ts apps/desktop/test/renderer/i18n.test.ts apps/desktop/test/renderer/enterprise.test.ts apps/desktop/test/renderer/hermesModel.test.ts
git commit -m "feat: the contract for the API tab and the Sites category (v0.7.0)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track A: the keys on the server

### Task A1: `apis` in `hermes.update`, the rules and the limit

**Files:** Create `apps/server/src/companyHermes/apis.ts`; Modify `apps/server/src/companyHermes/index.ts` (`'hermes.update'`, `features`), `apps/server/test/companyHermes.test.ts` (one new `describe` at the end).

- [ ] **Step 1: The failing tests**

At the end of `apps/server/test/companyHermes.test.ts` (it has `setup`, `admin`, `connectBot` and `fakeKey`):

```ts
describe('the API tab (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('only the owner saves and deletes keys; the app sees the last 4, only the company Hermes the keys', async () => {
    const { fx } = await setup();
    const ana = await admin(fx);
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    await hermes.event<HermesConfig>('hermes.config');
    const eleven = fakeKey('eleven');
    const mine = fakeKey('mine');
    const gemini = fakeKey('gemini');

    expect(await ana.fail('hermes.update', { apis: { ELEVENLABS_API_KEY: { value: eleven } } })).toBe('FORBIDDEN');
    const state = await fx.owner.ok<HermesState>('hermes.update', {
      keys: { gemini },
      apis: { ELEVENLABS_API_KEY: { value: eleven }, MINHA_API_KEY: { name: 'Minha API', value: mine } },
    });
    expect(state.keys.gemini).toEqual({ last4: gemini.slice(-4) });
    expect(state.apis).toEqual([
      { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', last4: eleven.slice(-4) },
      { envVar: 'MINHA_API_KEY', name: 'Minha API', last4: mine.slice(-4) },
    ]);
    const config = await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 1);
    expect(config.keys.gemini).toBe(gemini);
    expect(config.apis).toEqual({ ELEVENLABS_API_KEY: eleven, MINHA_API_KEY: mine });

    await Promise.all([impostor.sync(), ana.sync(), fx.owner.sync()]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    const answers = [JSON.stringify(fx.owner.events), JSON.stringify(ana.events), JSON.stringify(state), JSON.stringify(await fx.owner.ok('hermes.get', {}))];
    for (const seen of answers) for (const key of [eleven, mine, gemini]) expect(seen).not.toContain(key);

    const after = await fx.owner.ok<HermesState>('hermes.update', { apis: { MINHA_API_KEY: null } });
    expect(after.apis.map((a) => a.envVar)).toEqual(['ELEVENLABS_API_KEY']);
    expect((await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 2)).apis).toEqual({ ELEVENLABS_API_KEY: eleven });
  });

  it('refuses system, Hermes and GhostLink variables, an AI in apis, a nameless one and the 31st key', async () => {
    const { fx } = await setup();
    for (const name of ['PATH', 'LD_PRELOAD', 'PYTHONPATH', 'NODE_OPTIONS', 'HTTPS_PROXY', 'HERMES_HOME', 'GHOSTLINK_BOT', 'DEEPSEEK_API_KEY']) {
      expect(await fx.owner.fail('hermes.update', { apis: { [name]: { name: 'x', value: fakeKey('x') } } }), name).toBe('BAD_REQUEST');
    }
    expect(await fx.owner.fail('hermes.update', { apis: { SEM_NOME_KEY: { value: fakeKey('x') } } })).toBe('BAD_REQUEST');
    const thirty = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`API_${i}_KEY`, { name: `API ${i}`, value: fakeKey(String(i)) }]));
    await fx.owner.ok('hermes.update', { apis: thirty });
    expect(await fx.owner.fail('hermes.update', { keys: { 'openai-api': fakeKey('openai') } })).toBe('BAD_REQUEST');
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).apis).toHaveLength(30);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- apps/server/test/companyHermes.test.ts -t "the API tab"`
Expected: FAIL — `state.apis` is `[]` (the contract stores no `apis` yet) and `PATH` is taken.

- [ ] **Step 3: `apps/server/src/companyHermes/apis.ts`**

```ts
import {
  HERMES_API_CATALOG,
  HERMES_LIMITS,
  HERMES_PROVIDERS,
  HERMES_PROVIDER_ENV,
  ProtocolError,
  apiEnvVarProblem,
  sanitizeLabel,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import type { HermesApisChange, HermesRecord } from './store.js';

/**
 * The API tab's rules (spec 2026-10-03-aba-api-e-sites-design.md §1) for one hermes.update, before
 * anything is stored: `apis` names the catalog's other APIs or a variable of the owner's own that is not
 * a system, Hermes or GhostLink one (an AI's key goes in `keys`); a new variable of the owner's needs a
 * name; at most 30 keys in all, the AIs' included. Returns the change with each name settled. BAD_REQUEST
 * never echoes a variable or a key.
 */
export function checkApisChange(current: HermesRecord, p: Pick<HermesUpdatePayload, 'keys' | 'apis'>): HermesApisChange | undefined {
  const saved = new Set<string>([
    ...HERMES_PROVIDERS.filter((x) => current.keys[x] !== null).map((x) => HERMES_PROVIDER_ENV[x]),
    ...current.apis.map((a) => a.envVar),
  ]);
  for (const provider of HERMES_PROVIDERS) {
    const value = p.keys?.[provider];
    if (value === null) saved.delete(HERMES_PROVIDER_ENV[provider]);
    else if (value !== undefined) saved.add(HERMES_PROVIDER_ENV[provider]);
  }
  let out: HermesApisChange | undefined;
  if (p.apis !== undefined) {
    out = {};
    for (const [envVar, change] of Object.entries(p.apis)) {
      const problem = apiEnvVarProblem(envVar);
      if (problem === 'format' || problem === 'reserved') throw new ProtocolError('BAD_REQUEST', 'a reserved variable');
      const entry = HERMES_API_CATALOG.find((a) => a.envVar === envVar);
      if (entry?.provider) throw new ProtocolError('BAD_REQUEST', "an AI's key goes in keys");
      if (change === null) {
        out[envVar] = null;
        saved.delete(envVar);
        continue;
      }
      const name = entry?.name ?? sanitizeLabel(change.name ?? current.apis.find((a) => a.envVar === envVar)?.name ?? '', HERMES_LIMITS.apiNameMax);
      if (name === '') throw new ProtocolError('BAD_REQUEST', 'the API needs a name');
      out[envVar] = { name, value: change.value };
      saved.add(envVar);
    }
  }
  if (saved.size > HERMES_LIMITS.maxApis) throw new ProtocolError('BAD_REQUEST', 'too many keys');
  return out;
}
```

- [ ] **Step 4: Use it in `hermes.update` and announce the function**

In `apps/server/src/companyHermes/index.ts`:

- import `{ checkApisChange } from './apis.js'` and `FEATURE_ENTERPRISE_APIS` from `@ghostlink/shared`;
- in `'hermes.update'`, after the `viewerRoleId` checks:

```ts
      const apis = checkApisChange(s.store.load(), change);
      // The viewer role is GhostLink's alone: changing only it sends the Hermes nothing.
      const forHermes = change.keys !== undefined || apis !== undefined || change.models !== undefined || change.disabledSkills !== undefined || change.access !== undefined;
      s.ctx.db.tx(() => {
        if (forHermes) s.store.update({ keys: change.keys, apis, models: change.models, disabledSkills: change.disabledSkills, access: change.access });
        if (viewerRoleId !== undefined) s.store.setViewerRole(viewerRoleId);
      });
```

(replacing the old `forHermes` line and the `tx` block);
- `features: [FEATURE_ENTERPRISE_HERMES, FEATURE_ENTERPRISE_HERMES_VIEW, FEATURE_ENTERPRISE_APIS],`
- the header comment of the module: add "and the API tab (spec 2026-10-03-aba-api-e-sites-design.md §1)".

- [ ] **Step 5: Run, check, commit**

Run: `npm test -- apps/server/test/companyHermes.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add apps/server/src/companyHermes/apis.ts apps/server/src/companyHermes/index.ts apps/server/test/companyHermes.test.ts
git commit -m "feat(server): the API tab's keys: any API by variable, the deny rules and the 30-key limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track B: the sites on the server

### Task B1: The text module creates a channel for a module

**Files:** Modify `apps/server/src/text/handlers/channels.ts`, `apps/server/src/text/index.ts`.

- [ ] **Step 1: Extract `insertChannel` from `channel.create`**

In `apps/server/src/text/handlers/channels.ts`, add above `const create`:

```ts
/**
 * Inserts a channel after the others and announces it to whoever sees it (withVisibility sends
 * channel.created); its id. BAD_REQUEST past the channel limit. `name` is already clean.
 */
export function insertChannel(
  core: TextCore,
  c: { name: string; type: ChannelType; topic: string; private: boolean; allowed: readonly string[]; userLimit: number },
): string {
  const count = core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM channels');
  if (Number(count?.n ?? 0) >= core.maxChannels) throw new ProtocolError('BAD_REQUEST', 'too many channels');
  const id = newEntityId();
  const { db } = core;
  core.withVisibility(() => db.tx(() => {
    const max = db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM channels');
    db.run(
      'INSERT INTO channels (id, name, type, topic, position, private, user_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, c.name, c.type, c.topic, Number(max?.p ?? -1) + 1, c.private ? 1 : 0, c.userLimit, core.now(),
    );
    for (const roleId of c.allowed) db.run('INSERT INTO channel_allowed_roles (channel_id, role_id) VALUES (?, ?)', id, roleId);
  }));
  return id;
}
```

and make `create` use it (same checks first, same answer):

```ts
const create: Handler = (core, ctx, payload) => {
  const p = channelCreateSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_CHANNELS);
  const name = cleanChannelName(p.name, p.type);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty channel name');
  if (p.type === 'text' && (p.userLimit ?? 0) !== 0) throw new ProtocolError('BAD_REQUEST', 'userLimit is for voice channels');
  const allowed = checkAllowedRoles(core, p.allowedRoleIds ?? []);
  const id = insertChannel(core, { name, type: p.type, topic: cleanTopic(p.topic ?? ''), private: p.private ?? false, allowed, userLimit: p.userLimit ?? 0 });
  return { channel: core.repo.toChannel(core.repo.channel(id)!) };
};
```

- [ ] **Step 2: `TextModule.createTextChannel`**

In `apps/server/src/text/index.ts`, import `ProtocolError` from `@ghostlink/shared` and `{ cleanChannelName, insertChannel }` from `./handlers/channels.js`; add to the `TextModule` interface:

```ts
  /**
   * A new public text channel named `name` (cleaned as channel.create does), announced to whoever sees
   * it: the Sites category's "Criar canal novo" (spec 2026-10-03-aba-api-e-sites §2), for someone who
   * may lack MANAGE_CHANNELS. BAD_REQUEST: an empty name, or past the channel limit. Its id.
   */
  createTextChannel(name: string): string;
```

and to the returned object, after `announceServer()`:

```ts
    createTextChannel(raw) {
      const name = cleanChannelName(raw, 'text');
      if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty channel name');
      return insertChannel(need(), { name, type: 'text', topic: '', private: false, allowed: [], userLimit: 0 });
    },
```

- [ ] **Step 3: Nothing changed for channel.create**

Run: `npm test -- apps/server/test/text/requests.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/text/handlers/channels.ts apps/server/src/text/index.ts
git commit -m "refactor(server): a module may create a public text channel (insertChannel)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B2: The sites module

**Files:** Modify `apps/server/src/sites/index.ts`; Create `apps/server/test/sites.test.ts`.

- [ ] **Step 1: The failing tests**

`apps/server/test/sites.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BotCreateResult, Channel, Edition, HermesConfig, Site } from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule } from '../src/bots/index.js';
import { createCompanyHermesModule } from '../src/companyHermes/index.js';
import { createSitesModule } from '../src/sites/index.js';
import { connectBot } from './helpers/botClient.js';
import { fakeEnterprise } from './helpers/enterprise.js';
import { channelId, nextClientMsgId, textFixture, type TextClient, type TextFixture } from './text/helpers.js';

async function setup(edition: Edition = 'enterprise') {
  const enterprise = fakeEnterprise(edition);
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule(), enterprise, createCompanyHermesModule(), createSitesModule()] });
  return { fx, enterprise };
}

/** Ana, in a role without permissions that the owner makes the company Hermes page's role. */
async function pageRole(fx: TextFixture): Promise<TextClient> {
  const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Marketing', permissions: 0 });
  const ana = await fx.join({ nickname: 'Ana' });
  await fx.owner.ok('member.setRoles', { userId: ana.userId, roleIds: [role.id] });
  await fx.owner.ok('hermes.update', { viewerRoleId: role.id });
  return ana;
}

const sitesOf = (c: TextClient, pred: (sites: Site[]) => boolean) => c.event<{ sites: Site[] }>('sites.state', (d) => pred(d.sites)).then((d) => d.sites);

describe('the Sites category (spec 2026-10-03-aba-api-e-sites §2)', () => {
  it('the owner and the page role register sites; anyone else FORBIDDEN; a normal server ENTERPRISE_REQUIRED', async () => {
    const { fx } = await setup();
    const ana = await pageRole(fx);
    const bia = await fx.join({ nickname: 'Bia' });
    expect(await bia.fail('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null })).toBe('FORBIDDEN');

    // "Criar canal novo": a public text channel named after the address, even without MANAGE_CHANNELS.
    const { site } = await ana.ok<{ site: Site }>('site.create', { name: 'Profeta Cristão ES', domain: 'es.profetacristao.com', channelId: null });
    expect(site).toMatchObject({ name: 'Profeta Cristão ES', domain: 'es.profetacristao.com' });
    const created = await bia.event<{ channel: Channel }>('channel.created', (d) => d.channel.id === site.channelId);
    expect(created.channel).toMatchObject({ name: 'es.profetacristao.com', type: 'text', private: false });
    expect(await sitesOf(bia, (s) => s.length === 1)).toEqual([site]);
    expect(await ana.fail('site.create', { name: 'De novo', domain: 'es.profetacristao.com', channelId: null })).toBe('BAD_REQUEST');

    const edited = await ana.ok<{ site: Site }>('site.update', { id: site.id, name: 'Profeta ES' });
    expect(edited.site).toEqual({ ...site, name: 'Profeta ES' });
    expect(await bia.fail('site.delete', { id: site.id })).toBe('FORBIDDEN');

    const normal = await setup('normal');
    expect(await normal.fx.owner.fail('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null })).toBe('ENTERPRISE_REQUIRED');
  });

  it('an existing channel becomes a site with its history; removing the site gives the channel back', async () => {
    const { fx } = await setup();
    const geral = channelId(fx.owner, 'geral');
    const sent = await fx.owner.ok<{ message: { id: number } }>('msg.send', { channelId: geral, content: 'histórico', clientMsgId: nextClientMsgId() });
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: geral });
    expect(site.channelId).toBe(geral);
    const history = await fx.owner.ok<{ messages: { id: number }[] }>('msg.history', { channelId: geral });
    expect(history.messages.map((m) => m.id)).toContain(sent.message.id);
    expect(await fx.owner.fail('site.create', { name: 'Outro', domain: 'outro.tcflag.com.br', channelId: geral })).toBe('BAD_REQUEST');

    await fx.owner.ok('site.delete', { id: site.id });
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
    const again = await fx.owner.ok<{ messages: { id: number }[] }>('msg.history', { channelId: geral });
    expect(again.messages.map((m) => m.id)).toContain(sent.message.id);
  });

  it('who cannot see the channel cannot see the site; the company Hermes gets every site, another bot nothing', async () => {
    const { fx, enterprise } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'interno', type: 'text', private: true });
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    await hermes.event<HermesConfig>('hermes.config');

    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Interno', domain: 'interno.tcflag.com.br', channelId: channel.id });
    expect((await hermes.event<HermesConfig>('hermes.config', (c) => c.sites.length === 1)).sites).toEqual([site]);
    await Promise.all([ana.sync(), impostor.sync()]);
    expect(ana.seen('sites.state')).toEqual([]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    expect(await ana.fail('site.update', { id: site.id, name: 'x' })).toBe('FORBIDDEN');

    // The server stops being Enterprise: the owner's list empties; the rows stay for a renewal.
    fx.owner.clear();
    enterprise.set('normal');
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
    fx.owner.clear();
    enterprise.set('enterprise');
    expect(await sitesOf(fx.owner, (s) => s.length === 1)).toEqual([site]);

    // Deleting the channel takes its site: the Hermes gets the new list.
    const back = (await connectBot(fx, created.connectionToken)).client!;
    await back.event<HermesConfig>('hermes.config', (c) => c.sites.length === 1);
    fx.owner.clear();
    await fx.owner.ok('channel.delete', { id: channel.id });
    expect((await back.event<HermesConfig>('hermes.config', (c) => c.sites.length === 0)).sites).toEqual([]);
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
  });
});
```

(The company Hermes is disconnected when the server lapses — v0.6.0 — so the last part reconnects it as `back`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- apps/server/test/sites.test.ts`
Expected: FAIL — `site.create` is an unknown request.

- [ ] **Step 3: `apps/server/src/sites/index.ts`**

Replace the stub with:

```ts
import {
  FEATURE_ENTERPRISE_SITES,
  ProtocolError,
  SITE_LIMITS,
  sanitizeLabel,
  siteCreateSchema,
  siteDeleteSchema,
  siteUpdateSchema,
  type Site,
} from '@ghostlink/shared';
import { COMPANY_HERMES_MODULE_NAME, type CompanyHermesModule } from '../companyHermes/index.js';
import { enterpriseOf, type EnterpriseModule } from '../enterprise/index.js';
import type { ModuleContext, RequestHandler, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { newEntityId } from '../text/repo.js';

export const SITES_MODULE_NAME = 'sites';

/**
 * The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2): sites are rows pointing at text
 * channels (the sidebar shows those channels under SITES). Managed by the owner and the company Hermes
 * page's role in an Enterprise server; each member sees the sites whose channel they see; the company
 * Hermes gets them all in hermes.config. Register after companyHermes.
 */
export interface SitesModule extends ServerModule {
  readonly name: typeof SITES_MODULE_NAME;
}

interface Row {
  id: string;
  name: string;
  domain: string;
  channel_id: string;
}

interface State {
  ctx: ModuleContext;
  text: TextModule;
  enterprise: EnterpriseModule | null;
  hermes: CompanyHermesModule;
  changes: SlidingWindowLimiter;
}

const toSite = (r: Row): Site => ({ id: r.id, name: r.name, domain: r.domain, channelId: r.channel_id });

export function createSitesModule(): SitesModule {
  let state: State | null = null;
  /** Per user, the list their apps have now (JSON): a change goes out once. Absent: none. */
  const sent = new Map<string, string>();
  /** What hermes.config last carried (JSON): a site lost with its channel sends a new version. */
  let forHermes = '[]';
  const need = (): State => {
    if (!state) throw new Error('the sites module is not initialized');
    return state;
  };

  const isEnterprise = (s: State): boolean => s.enterprise?.edition === 'enterprise';
  const all = (s: State): Site[] =>
    s.ctx.db
      .all<Row>('SELECT id, name, domain, channel_id FROM sites')
      .map(toSite)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
  const sees = (s: State, userId: string, channelId: string): boolean => s.text.voiceAccess.permissions(userId, channelId) !== 0;
  const listFor = (s: State, userId: string): Site[] => (isEnterprise(s) ? all(s).filter((x) => sees(s, userId, x.channelId)) : []);

  /** `sites.state` to whoever's list changed (`only`: just that user). */
  const announce = (s: State, only?: string): void => {
    const sessions = s.ctx.sessions.list();
    const users = new Set(sessions.map((x) => x.userId));
    for (const userId of only === undefined ? users : users.has(only) ? [only] : []) {
      const sites = listFor(s, userId);
      const json = JSON.stringify(sites);
      if ((sent.get(userId) ?? '[]') === json) continue;
      sent.set(userId, json);
      for (const x of sessions) if (x.userId === userId) s.ctx.sessions.send(x.sessionId, { t: 'sites.state', d: { sites } });
    }
  };

  /** A new hermes.config version when the company's sites changed. */
  const syncHermes = (s: State): void => {
    const json = JSON.stringify(all(s));
    if (json === forHermes) return;
    forHermes = json;
    s.hermes.sitesChanged();
  };

  const changed = (s: State): void => {
    announce(s);
    syncHermes(s);
  };

  const requireManager = (s: State, userId: string): void => {
    if (!s.hermes.seesPage(userId)) throw new ProtocolError('FORBIDDEN');
    if (!isEnterprise(s)) throw new ProtocolError('ENTERPRISE_REQUIRED');
    if (!s.changes.hit(userId)) throw new ProtocolError('RATE_LIMITED');
  };
  const visibleSite = (s: State, userId: string, id: string): Row => {
    const row = s.ctx.db.get<Row>('SELECT id, name, domain, channel_id FROM sites WHERE id = ?', id);
    if (!row || !sees(s, userId, row.channel_id)) throw new ProtocolError('NOT_FOUND');
    return row;
  };
  const cleanName = (raw: string): string => {
    const name = sanitizeLabel(raw, SITE_LIMITS.nameMax);
    if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty site name');
    return name;
  };
  const requireFreeDomain = (s: State, domain: string, except?: string): void => {
    const row = s.ctx.db.get<{ id: string }>('SELECT id FROM sites WHERE domain = ?', domain);
    if (row && row.id !== except) throw new ProtocolError('BAD_REQUEST', 'a site has this domain');
  };

  const handlers: Record<string, RequestHandler> = {
    'site.create': (rc, payload) => {
      const p = siteCreateSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      const name = cleanName(p.name);
      if (all(s).length >= SITE_LIMITS.maxSites) throw new ProtocolError('BAD_REQUEST', 'too many sites');
      requireFreeDomain(s, p.domain);
      let channelId: string;
      if (p.channelId === null) {
        channelId = s.text.createTextChannel(p.domain);
      } else {
        const channel = s.text.voiceAccess.channel(p.channelId);
        if (!channel || !sees(s, rc.userId, p.channelId)) throw new ProtocolError('NOT_FOUND');
        if (channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'a site needs a text channel');
        if (s.ctx.db.get('SELECT 1 AS x FROM sites WHERE channel_id = ?', p.channelId)) throw new ProtocolError('BAD_REQUEST', 'the channel already is a site');
        channelId = p.channelId;
      }
      const site: Site = { id: newEntityId(), name, domain: p.domain, channelId };
      s.ctx.db.run(
        'INSERT INTO sites (id, name, domain, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        site.id, site.name, site.domain, site.channelId, rc.userId, s.ctx.now(),
      );
      changed(s);
      return { site };
    },

    'site.update': (rc, payload) => {
      const p = siteUpdateSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      const row = visibleSite(s, rc.userId, p.id);
      const name = p.name === undefined ? row.name : cleanName(p.name);
      const domain = p.domain ?? row.domain;
      requireFreeDomain(s, domain, row.id);
      s.ctx.db.run('UPDATE sites SET name = ?, domain = ? WHERE id = ?', name, domain, row.id);
      changed(s);
      return { site: { id: row.id, name, domain, channelId: row.channel_id } satisfies Site };
    },

    'site.delete': (rc, payload) => {
      const p = siteDeleteSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      const row = visibleSite(s, rc.userId, p.id);
      s.ctx.db.run('DELETE FROM sites WHERE id = ?', row.id);
      changed(s);
      return {};
    },
  };

  return {
    name: SITES_MODULE_NAME,
    features: [FEATURE_ENTERPRISE_SITES],
    handlers,

    init(c) {
      state = {
        ctx: c,
        text: c.getModule<TextModule>(TEXT_MODULE_NAME),
        enterprise: enterpriseOf(c),
        hermes: c.getModule<CompanyHermesModule>(COMPANY_HERMES_MODULE_NAME),
        changes: new SlidingWindowLimiter(SITE_LIMITS.changesPerMinute, 60_000, c.now),
      };
      const s = state;
      forHermes = JSON.stringify(all(s));
      s.hermes.useSites(() => all(s));
      s.enterprise?.onChange(() => announce(s));
      s.text.events.on('visibility.changed', ({ userId }) => announce(s, userId));
      s.text.events.on('access.changed', () => announce(s));
      // ON DELETE CASCADE took its site, if it had one.
      s.text.events.on('channel.deleted', () => changed(s));
      s.text.events.on('membership.removed', ({ userId }) => sent.delete(userId));
    },

    welcome: (session) => {
      const s = need();
      if (!isEnterprise(s)) return {};
      const sites = listFor(s, session.userId);
      sent.set(session.userId, JSON.stringify(sites));
      return { sites };
    },
  };
}
```

- [ ] **Step 4: Run, check, commit**

Run: `npm test -- apps/server/test/sites.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add apps/server/src/sites/index.ts apps/server/test/sites.test.ts
git commit -m "feat(server): the Sites category: sites on text channels, managed by the owner and the page role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track C: the API tab (desktop)

### Task C1: The API tab's helpers

**Files:** Create `apps/desktop/src/renderer/features/bots/hermes/apiModel.ts`, `apps/desktop/test/renderer/apiModel.test.ts`.

- [ ] **Step 1: The failing test**

`apps/desktop/test/renderer/apiModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HERMES_DEFAULT_SETTINGS, type HermesReport, type HermesState } from '@ghostlink/shared';
import { apiPatch, apiRows, newApiPatch, otherApiProblem, savedKeys } from '../../src/renderer/features/bots/hermes/apiModel.js';

const NO_KEYS = { deepseek: null, openrouter: null, 'openai-api': null, anthropic: null, gemini: null };
const report = (keys: Partial<HermesReport['status']['keys']>): HermesReport => ({
  appliedVersion: 1,
  skills: [],
  memory: { company: [], people: [] },
  status: { model: null, fallback: null, keys: { deepseek: 'missing', openrouter: 'missing', 'openai-api': 'missing', anthropic: 'missing', gemini: 'missing', ...keys }, unsupported: null, envOverride: [] },
});
const state = (o: Partial<HermesState> = {}): HermesState => ({
  botId: 'b'.repeat(32), connected: true, locked: false, keys: NO_KEYS, apis: [], settings: HERMES_DEFAULT_SETTINGS,
  version: 1, report: null, reportAt: null, viewerRoleId: null, ...o,
});

describe('the API tab (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('lists the AIs, the other APIs, then the owner’s own by name, each with its last 4 and the AIs’ key test', () => {
    const s = state({
      keys: { ...NO_KEYS, deepseek: { last4: 'ab12' }, gemini: { last4: 'cd34' } },
      apis: [
        { envVar: 'ZETA_KEY', name: 'Zeta', last4: 'zz99' },
        { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', last4: 'ee11' },
        { envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' },
      ],
      report: report({ deepseek: 'ok', gemini: 'refused' }),
    });
    const rows = apiRows(s, true);
    expect(rows.map((r) => [r.group, r.envVar])).toEqual([
      ['ai', 'DEEPSEEK_API_KEY'], ['ai', 'OPENROUTER_API_KEY'], ['ai', 'OPENAI_API_KEY'], ['ai', 'ANTHROPIC_API_KEY'], ['ai', 'GEMINI_API_KEY'],
      ['other', 'ELEVENLABS_API_KEY'], ['other', 'GROK_API_KEY'], ['other', 'YUNWU_API_KEY'],
      ['custom', 'ALFA_KEY'], ['custom', 'ZETA_KEY'],
    ]);
    expect(rows[0]).toMatchObject({ name: 'DeepSeek', last4: 'ab12', test: 'ok' });
    expect(rows[1]).toMatchObject({ last4: null, test: null });
    expect(rows[4]).toMatchObject({ name: 'Google Gemini', last4: 'cd34', test: 'refused' });
    expect(rows[5]).toMatchObject({ last4: 'ee11', test: null });
    expect(savedKeys(s)).toBe(5);
  });

  it('a server without enterpriseApis: DeepSeek and OpenRouter only', () => {
    expect(apiRows(state({ apis: [{ envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' }] }), false).map((r) => r.envVar)).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
  });

  it('checks "Outra API" before sending', () => {
    const s = state({ apis: [{ envVar: 'ALFA_KEY', name: 'Alfa', last4: 'aa00' }] });
    const ok = { name: 'Minha API', envVar: 'MINHA_API_KEY', key: 'fake-key-0001' };
    expect(otherApiProblem(s, ok)).toBeNull();
    expect(otherApiProblem(s, { ...ok, name: '  ' })).toBe('name');
    expect(otherApiProblem(s, { ...ok, envVar: 'minha' })).toBe('format');
    expect(otherApiProblem(s, { ...ok, envVar: 'HERMES_KEY' })).toBe('reserved');
    expect(otherApiProblem(s, { ...ok, envVar: 'GROK_API_KEY' })).toBe('catalog');
    expect(otherApiProblem(s, { ...ok, envVar: 'ALFA_KEY' })).toBe('taken');
    expect(otherApiProblem(s, { ...ok, key: 'curta' })).toBe('key');
    const full = state({ apis: Array.from({ length: 30 }, (_, i) => ({ envVar: `API_${i}_KEY`, name: `API ${i}`, last4: '0000' })) });
    expect(otherApiProblem(full, ok)).toBe('limit');
  });

  it('saves an AI through keys and the others through apis', () => {
    expect(apiPatch({ envVar: 'GEMINI_API_KEY', provider: 'gemini' }, ' fake-key-0001 ')).toEqual({ keys: { gemini: 'fake-key-0001' } });
    expect(apiPatch({ envVar: 'GEMINI_API_KEY', provider: 'gemini' }, null)).toEqual({ keys: { gemini: null } });
    expect(apiPatch({ envVar: 'YUNWU_API_KEY', provider: null }, 'fake-key-0001')).toEqual({ apis: { YUNWU_API_KEY: { value: 'fake-key-0001' } } });
    expect(apiPatch({ envVar: 'ALFA_KEY', provider: null }, null)).toEqual({ apis: { ALFA_KEY: null } });
    expect(newApiPatch({ name: ' Minha API ', envVar: 'MINHA_API_KEY', key: 'fake-key-0001' })).toEqual({ apis: { MINHA_API_KEY: { name: 'Minha API', value: 'fake-key-0001' } } });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- apps/desktop/test/renderer/apiModel.test.ts`
Expected: FAIL — `apiModel.js` does not exist.

- [ ] **Step 3: `apps/desktop/src/renderer/features/bots/hermes/apiModel.ts`**

```ts
// The API tab of the company Hermes's page (spec 2026-10-03-aba-api-e-sites-design.md §1): its rows and
// checks, from the owner's HermesState. No React and no stores, so the tests load it.
import {
  HERMES_API_CATALOG,
  HERMES_LIMITS,
  HERMES_PROVIDERS_V1,
  apiEnvVarProblem,
  type HermesKeyStatus,
  type HermesProvider,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';

export type ApiGroup = 'ai' | 'other' | 'custom';

export interface ApiRow {
  envVar: string;
  name: string;
  group: ApiGroup;
  /** The AI provider; null for the other APIs. */
  provider: HermesProvider | null;
  /** The saved key's last 4; null: "não configurada". */
  last4: string | null;
  /** An AI's key test as the Hermes reported it ("ok" / "recusada" / "sem resposta"); null: none to show. */
  test: 'ok' | 'refused' | 'unreachable' | null;
}

const shownTest = (status: HermesKeyStatus | undefined): ApiRow['test'] =>
  status === 'ok' || status === 'refused' || status === 'unreachable' ? status : null;

/**
 * The rows: the catalog's AIs, its other APIs, then the owner's own by name. `full`: the server has
 * `enterpriseApis`; before it, DeepSeek and OpenRouter only (plan decision 7).
 */
export function apiRows(state: HermesState, full: boolean): ApiRow[] {
  const v1: readonly string[] = HERMES_PROVIDERS_V1;
  const rows: ApiRow[] = HERMES_API_CATALOG.filter((a) => full || (a.provider !== null && v1.includes(a.provider))).map((a) => {
    const last4 = a.provider !== null ? (state.keys[a.provider]?.last4 ?? null) : (state.apis.find((x) => x.envVar === a.envVar)?.last4 ?? null);
    return {
      envVar: a.envVar,
      name: a.name,
      group: a.provider !== null ? 'ai' : 'other',
      provider: a.provider,
      last4,
      test: a.provider !== null && last4 !== null ? shownTest(state.report?.status.keys[a.provider]) : null,
    };
  });
  if (!full) return rows;
  const own = state.apis
    .filter((x) => !HERMES_API_CATALOG.some((a) => a.envVar === x.envVar))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.envVar.localeCompare(b.envVar));
  return [...rows, ...own.map((x): ApiRow => ({ envVar: x.envVar, name: x.name, group: 'custom', provider: null, last4: x.last4, test: null }))];
}

/** Keys saved in all (the limit of 30 counts the AIs' too). */
export function savedKeys(state: HermesState): number {
  return Object.values(state.keys).filter((k) => k !== null).length + state.apis.length;
}

export type OtherApiProblem = 'name' | 'format' | 'reserved' | 'catalog' | 'taken' | 'key' | 'limit';

/** "Outra API": what is wrong before it is sent, or null. */
export function otherApiProblem(state: HermesState, f: { name: string; envVar: string; key: string }): OtherApiProblem | null {
  if (f.name.trim() === '') return 'name';
  const problem = apiEnvVarProblem(f.envVar);
  if (problem !== null) return problem;
  if (state.apis.some((a) => a.envVar === f.envVar)) return 'taken';
  if (!/^[\x21-\x7e]{8,512}$/.test(f.key.trim())) return 'key';
  if (savedKeys(state) >= HERMES_LIMITS.maxApis) return 'limit';
  return null;
}

/** The hermes.update that saves a row's key (`null` deletes it). */
export function apiPatch(row: Pick<ApiRow, 'envVar' | 'provider'>, key: string | null): HermesUpdatePayload {
  const value = key === null ? null : key.trim();
  if (row.provider !== null) return { keys: { [row.provider]: value } };
  return { apis: { [row.envVar]: value === null ? null : { value } } };
}

/** The hermes.update that adds "Outra API". */
export function newApiPatch(f: { name: string; envVar: string; key: string }): HermesUpdatePayload {
  return { apis: { [f.envVar]: { name: f.name.trim(), value: f.key.trim() } } };
}
```

- [ ] **Step 4: Run, commit**

Run: `npm test -- apps/desktop/test/renderer/apiModel.test.ts`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/features/bots/hermes/apiModel.ts apps/desktop/test/renderer/apiModel.test.ts
git commit -m "feat(desktop): the API tab's rows and checks as pure helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C2: The 6th tab on the page; "Chaves de IA" leaves the settings

**Files:** Create `apps/desktop/src/renderer/features/bots/hermes/ApiTab.tsx`; Modify `apps/desktop/src/renderer/features/bots/hermes/{HermesPage.tsx,HermesTabs.tsx,hermesPageModel.ts,hermes.module.css}`, `apps/desktop/src/renderer/i18n/enterprise.{pt-BR,en}.ts`, `apps/desktop/test/renderer/hermesPageModel.test.ts`.

- [ ] **Step 1: The tabs' test (failing)**

In `apps/desktop/test/renderer/hermesPageModel.test.ts`, the tabs test becomes:

```ts
  it('the owner sees six tabs, API after Memória; the role holder has no Memória and no API', () => {
    expect(hermesPageTabs(true)).toEqual(['overview', 'skills', 'access', 'memory', 'api', 'commands']);
    expect(hermesPageTabs(false)).toEqual(['overview', 'skills', 'access', 'commands']);
  });
```

Run: `npm test -- apps/desktop/test/renderer/hermesPageModel.test.ts` → FAIL.

- [ ] **Step 2: `hermesPageModel.ts`**

```ts
export type HermesPageTab = 'overview' | 'skills' | 'access' | 'memory' | 'api' | 'commands';

/** The tabs under the badge: Memória and API (v0.7.0) are the owner's only. */
export function hermesPageTabs(owner: boolean): HermesPageTab[] {
  return owner ? ['overview', 'skills', 'access', 'memory', 'api', 'commands'] : ['overview', 'skills', 'access', 'commands'];
}
```

- [ ] **Step 3: `ApiTab.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { FEATURE_ENTERPRISE_APIS, HERMES_LIMITS, type HermesState } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../../i18n/index.js';
import { ConfirmDialog, ErrorText, primitives as p } from '../../../layout/primitives.js';
import s from '../../../layout/settings.module.css';
import { useConnectionStore } from '../../../stores/connection.js';
import g from '../botPage.module.css';
import { apiPatch, apiRows, newApiPatch, otherApiProblem, savedKeys, type ApiGroup, type ApiRow } from './apiModel.js';
import { updateHermes } from './hermesActions.js';
import h from './hermes.module.css';

const GROUPS: readonly ApiGroup[] = ['ai', 'other', 'custom'];
const TEST_TEXT = { ok: 'hermes.api.test.ok', refused: 'hermes.api.test.refused', unreachable: 'hermes.api.test.unreachable' } as const;

/**
 * API (spec 2026-10-03-aba-api-e-sites-design.md §1), the company Hermes page's 6th tab, the owner's
 * only: the catalog's AIs and other APIs, then the owner's own, each "configurada (final 1234)" or
 * "não configurada" with Trocar and Apagar, the AIs with their key test; then "Outra API". Saves through
 * hermes.update (the answer and hermes.state refresh it); a key typed here is never kept.
 */
export function ApiTab({ state }: { state: HermesState }) {
  const t = useT();
  const full = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_ENTERPRISE_APIS) === true);
  const rows = apiRows(state, full);
  const atLimit = savedKeys(state) >= HERMES_LIMITS.maxApis;
  return (
    <section aria-label={t('hermes.page.tab.api')} className={h.apiPanel} data-hermes-api>
      <p className={h.pageEmpty}>{t('hermes.api.intro')}</p>
      {!full && <p className={h.pageEmpty}>{t('hermes.api.oldServer')}</p>}
      {GROUPS.map((group) => {
        const list = rows.filter((r) => r.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`hermes-api-${group}`}>
            <h2 id={`hermes-api-${group}`} className={g.sectionTitle}>
              {t(`hermes.api.group.${group}`)}
            </h2>
            <ul className={h.apiList}>
              {list.map((row) => (
                <ApiRowItem key={row.envVar} row={row} locked={state.locked} atLimit={atLimit} />
              ))}
            </ul>
          </section>
        );
      })}
      {full && <OtherApiForm state={state} />}
    </section>
  );
}

function ApiRowItem({ row, locked, atLimit }: { row: ApiRow; locked: boolean; atLimit: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const empty = row.last4 === null;
  const save = async (key: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await updateHermes(apiPatch(row, key));
      setValue('');
      setEditing(false);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || locked || (empty && atLimit);
  return (
    <li className={h.apiRow} data-hermes-api-row={row.envVar}>
      <div className={h.apiHead}>
        <span className={h.apiName}>{row.name}</span>
        <code className={h.apiVar}>{row.envVar}</code>
        <span className={h.factMuted}>{empty ? t('hermes.keys.none') : t('hermes.keys.set', { last4: row.last4! })}</span>
        {row.test !== null && (
          <span className={row.test === 'ok' ? h.apiTestOk : h.apiTestBad} data-hermes-api-test={row.test}>
            {t(TEST_TEXT[row.test])}
          </span>
        )}
      </div>
      {empty || editing ? (
        <form
          className={s.row}
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value);
          }}
        >
          <input
            className={s.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={HERMES_LIMITS.keyMax}
            aria-label={`${row.name}: ${t('hermes.api.key')}`}
            placeholder={t('hermes.keys.paste')}
            value={value}
            disabled={blocked}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={blocked || value.trim() === ''}>
            {t('hermes.keys.save')}
          </button>
          {editing && (
            <button type="button" className={p.button} disabled={busy} onClick={() => { setEditing(false); setValue(''); }}>
              {t('common.cancel')}
            </button>
          )}
        </form>
      ) : (
        <div className={s.row}>
          <button type="button" className={p.button} disabled={locked} onClick={() => setEditing(true)}>
            {t('hermes.keys.change')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={locked} onClick={() => setConfirming(true)}>
            {t('hermes.keys.delete')}
          </button>
        </div>
      )}
      {error && <ErrorText code={error} />}
      {confirming && (
        <ConfirmDialog
          title={t('hermes.api.deleteTitle', { name: row.name })}
          body={t('hermes.api.deleteBody', { name: row.name })}
          confirmLabel={t('hermes.keys.delete')}
          onConfirm={() => save(null)}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

function OtherApiForm({ state }: { state: HermesState }) {
  const t = useT();
  const [name, setName] = useState('');
  const [envVar, setEnvVar] = useState('');
  const [key, setKey] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = otherApiProblem(state, { name, envVar, key });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      await updateHermes(newApiPatch({ name, envVar, key }));
      setName('');
      setEnvVar('');
      setKey('');
      setTried(false);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || state.locked;
  return (
    <section aria-labelledby="hermes-api-new">
      <h2 id="hermes-api-new" className={g.sectionTitle}>
        {t('hermes.api.other')}
      </h2>
      <p className={h.pageEmpty}>{t('hermes.api.otherHint')}</p>
      <form className={h.apiForm} onSubmit={(e) => void submit(e)} data-hermes-api-new>
        <input className={s.input} aria-label={t('hermes.api.name')} placeholder={t('hermes.api.name')} maxLength={HERMES_LIMITS.apiNameMax} value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        <input
          className={`${s.input} ${h.apiVarInput}`}
          aria-label={t('hermes.api.envVar')}
          placeholder={t('hermes.api.envVarExample')}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          value={envVar}
          disabled={disabled}
          onChange={(e) => setEnvVar(e.target.value.toUpperCase())}
        />
        <input className={s.input} type="password" aria-label={t('hermes.api.key')} placeholder={t('hermes.keys.paste')} maxLength={HERMES_LIMITS.keyMax} autoComplete="off" spellCheck={false} value={key} disabled={disabled} onChange={(e) => setKey(e.target.value)} />
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={disabled}>
          {t('hermes.api.add')}
        </button>
      </form>
      {tried && problem !== null && (
        <p className={p.error} role="alert">
          {t(`hermes.api.problem.${problem}`)}
        </p>
      )}
      {error && <ErrorText code={error} />}
    </section>
  );
}
```

- [ ] **Step 4: The page renders it**

In `HermesPage.tsx`: import `{ ApiTab } from './ApiTab.js'`; in `label(id)` add `if (id === 'api') return t('hermes.page.tab.api');` before the final `return`; after the `tab === 'memory'` panel:

```tsx
        {tab === 'api' && ownState !== null && <ApiTab state={ownState} />}
```

Update the component's doc comment: "six tabs (…, Memória and API for the owner only, Comandos)".

- [ ] **Step 5: "Chaves de IA" leaves the settings**

In `HermesTabs.tsx`:

- delete `KeysTab`, `KeyRow` and the `tab('hermesKeys', …)` line; the doc comment of `hermesSettingsTabs` says "four tabs";
- the label cast becomes `as 'hermes.tab.models'`;
- remove the imports only they used (`ConfirmDialog`, `HERMES_PROVIDERS`), keep `useId` (ModelsTab, ModelField use it).

- [ ] **Step 6: The styles**

Append to `hermes.module.css`:

```css
/* The API tab (v0.7.0). */
.apiPanel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.apiList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.apiRow {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.apiHead {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
}

.apiName {
  font-weight: 600;
  color: var(--text-normal);
}

.apiVar,
.apiVarInput {
  font-family: var(--font-code);
  font-size: 12px;
}

.apiTestOk,
.apiTestBad {
  font-size: 12px;
  font-weight: 600;
}

.apiTestOk {
  color: var(--status-positive);
}

.apiTestBad {
  color: var(--status-danger);
}

.apiForm {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}

@media (max-width: 720px) {
  .apiForm {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Use the variable names `hermes.module.css` already uses for the card background, code font and the ok / danger colors (check `.card`, `.dotOk`, `.dotError` and swap them in if they differ).

- [ ] **Step 7: The texts**

In `enterprise.pt-BR.ts`: delete `'hermes.tab.keys'`, `'hermes.keys.intro'`, `'hermes.keys.deleteTitle'` and `'hermes.keys.deleteBody'`; change `'hermes.models.noKeys'` to `'Salve uma chave de IA na aba API da página do Hermes primeiro.'`; add:

```ts
  'hermes.page.tab.api': 'API',
  'hermes.api.intro': 'As chaves que o Hermes usa. Depois de salvas, só aparecem os últimos 4 caracteres.',
  'hermes.api.oldServer': 'Atualize o servidor para cadastrar outras APIs.',
  'hermes.api.group.ai': 'IA',
  'hermes.api.group.other': 'Outras',
  'hermes.api.group.custom': 'Suas APIs',
  'hermes.api.test.ok': 'teste: ok',
  'hermes.api.test.refused': 'teste: recusada',
  'hermes.api.test.unreachable': 'teste: sem resposta',
  'hermes.api.key': 'Chave',
  'hermes.api.deleteTitle': 'Apagar a chave de {name}?',
  'hermes.api.deleteBody': 'O Hermes deixa de ter a chave de {name} até uma nova ser salva.',
  'hermes.api.other': 'Outra API',
  'hermes.api.otherHint': 'Para as skills: a chave fica na variável escolhida, que os scripts delas leem.',
  'hermes.api.name': 'Nome',
  'hermes.api.envVar': 'Variável',
  'hermes.api.envVarExample': 'MINHA_API_KEY',
  'hermes.api.add': 'Adicionar API',
  'hermes.api.problem.name': 'Dê um nome à API.',
  'hermes.api.problem.format': 'A variável começa com letra e usa só maiúsculas, números e _, de 3 a 64 caracteres.',
  'hermes.api.problem.reserved': 'Essa variável é do sistema, do Hermes ou do GhostLink.',
  'hermes.api.problem.catalog': 'Essa API já está na lista acima.',
  'hermes.api.problem.taken': 'Já existe uma API com essa variável.',
  'hermes.api.problem.key': 'Cole a chave inteira, sem espaços.',
  'hermes.api.problem.limit': 'O limite é de 30 chaves.',
```

and add `'hermes.page.tab.api'` and `'hermes.api.envVarExample'` to `ENTERPRISE_SAME_IN_BOTH`. In `enterprise.en.ts` the same deletions and change (`'Save an AI key in the Hermes page’s API tab first.'`) and:

```ts
  'hermes.page.tab.api': 'API',
  'hermes.api.intro': 'The keys the Hermes uses. Once saved, only their last 4 characters show.',
  'hermes.api.oldServer': 'Update the server to add other APIs.',
  'hermes.api.group.ai': 'AI',
  'hermes.api.group.other': 'Others',
  'hermes.api.group.custom': 'Your APIs',
  'hermes.api.test.ok': 'test: ok',
  'hermes.api.test.refused': 'test: refused',
  'hermes.api.test.unreachable': 'test: no answer',
  'hermes.api.key': 'Key',
  'hermes.api.deleteTitle': 'Delete the {name} key?',
  'hermes.api.deleteBody': 'The Hermes has no {name} key until a new one is saved.',
  'hermes.api.other': 'Another API',
  'hermes.api.otherHint': 'For skills: the key goes in the variable you choose, which their scripts read.',
  'hermes.api.name': 'Name',
  'hermes.api.envVar': 'Variable',
  'hermes.api.envVarExample': 'MINHA_API_KEY',
  'hermes.api.add': 'Add API',
  'hermes.api.problem.name': 'Give the API a name.',
  'hermes.api.problem.format': 'The variable starts with a letter and uses only capitals, digits and _, 3 to 64 characters.',
  'hermes.api.problem.reserved': 'That variable belongs to the system, Hermes or GhostLink.',
  'hermes.api.problem.catalog': 'That API is already in the list above.',
  'hermes.api.problem.taken': 'An API with that variable exists.',
  'hermes.api.problem.key': 'Paste the whole key, without spaces.',
  'hermes.api.problem.limit': 'The limit is 30 keys.',
```

(`common.cancel` exists already.)

- [ ] **Step 8: Run, check, commit**

Run: `npm test -- apps/desktop/test/renderer/hermesPageModel.test.ts apps/desktop/test/renderer/apiModel.test.ts apps/desktop/test/renderer/i18n.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/features/bots/hermes/ApiTab.tsx apps/desktop/src/renderer/features/bots/hermes/HermesPage.tsx apps/desktop/src/renderer/features/bots/hermes/HermesTabs.tsx apps/desktop/src/renderer/features/bots/hermes/hermesPageModel.ts apps/desktop/src/renderer/features/bots/hermes/hermes.module.css apps/desktop/src/renderer/i18n/enterprise.pt-BR.ts apps/desktop/src/renderer/i18n/enterprise.en.ts apps/desktop/test/renderer/hermesPageModel.test.ts
git commit -m "feat(desktop): the API tab on the company Hermes's page; AI keys leave the settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track D: the SITES category (desktop)

### Task D1: The sites in the store, and the helpers

**Files:** Create `apps/desktop/src/renderer/features/sites/{siteModel.ts,siteActions.ts}`, `apps/desktop/test/renderer/siteModel.test.ts`; Modify `apps/desktop/src/renderer/stores/enterprise.ts`, `apps/desktop/test/renderer/enterprise.test.ts`.

- [ ] **Step 1: The failing tests**

`apps/desktop/test/renderer/siteModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Channel, HermesView, Site } from '@ghostlink/shared';
import { canManageSites, freeTextChannels, showSitesSection, siteFormProblem, siteLikeChannels, siteRows, withoutSites } from '../../src/renderer/features/sites/siteModel.js';

const channel = (id: string, name: string, position: number, type: Channel['type'] = 'text'): Channel => ({ id, name, type, topic: '', position, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0 });
const byId = {
  g: channel('g', 'geral', 0),
  e: channel('e', 'es.profetacristao.com', 1),
  l: channel('l', 'loja.tcflag.com.br', 2),
  v: channel('v', 'v0.6.3', 3),
  c: channel('c', 'Chamada', 4, 'voice'),
};
const site = (id: string, name: string, channelId: string): Site => ({ id, name, domain: `${id}.com`, channelId });
const view = {} as HermesView;

describe('the SITES category (spec 2026-10-03-aba-api-e-sites §2)', () => {
  it('the owner and the page role manage sites, in an Enterprise server with the function', () => {
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: true, view: null })).toBe(true);
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: false, view })).toBe(true);
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: false, view: null })).toBe(false);
    expect(canManageSites({ supported: true, edition: 'normal', owner: true, view: null })).toBe(false);
    expect(canManageSites({ supported: false, edition: 'enterprise', owner: true, view: null })).toBe(false);
  });

  it('SITES shows with a site, or to whoever manages them', () => {
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 1, canManage: false })).toBe(true);
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 0, canManage: true })).toBe(true);
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 0, canManage: false })).toBe(false);
    expect(showSitesSection({ supported: true, edition: 'normal', sites: 2, canManage: true })).toBe(false);
  });

  it('a site’s channel leaves "Canais de texto"; sites sort by name and need their channel', () => {
    const sites = [site('z', 'Zeta', 'l'), site('a', 'Alfa', 'e'), site('x', 'Sem canal', 'gone')];
    expect(siteRows(sites, byId).map((r) => [r.site.name, r.channel.id])).toEqual([['Alfa', 'e'], ['Zeta', 'l']]);
    expect(withoutSites(Object.values(byId), sites).map((c) => c.id)).toEqual(['g', 'v', 'c']);
    expect(freeTextChannels(byId, sites).map((c) => c.id)).toEqual(['g', 'v']);
  });

  it('suggests the text channels named like a site that are not sites yet (decision 3)', () => {
    expect(siteLikeChannels(byId, []).map((c) => c.id)).toEqual(['e', 'l']);
    expect(siteLikeChannels(byId, [site('a', 'Alfa', 'e')]).map((c) => c.id)).toEqual(['l']);
  });

  it('checks the form: a name, a bare address, at most 50', () => {
    expect(siteFormProblem({ name: 'Loja', domain: 'https://loja.tcflag.com.br/', creating: true, count: 0 })).toBeNull();
    expect(siteFormProblem({ name: ' ', domain: 'loja.tcflag.com.br', creating: true, count: 0 })).toBe('name');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br/blog', creating: true, count: 0 })).toBe('domain');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br', creating: true, count: 50 })).toBe('limit');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br', creating: false, count: 50 })).toBeNull();
  });
});
```

In `apps/desktop/test/renderer/enterprise.test.ts`, inside `describe('the enterprise store …')`:

```ts
  it('keeps the sites the server sends (v0.7.0); none from an older server', () => {
    const site = { id: 'S'.repeat(26), name: 'Loja', domain: 'loja.tcflag.com.br', channelId: 'C'.repeat(26) };
    let s = enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({ sites: [site] }) });
    expect(s.sites).toEqual([site]);
    s = enterpriseReducer(s, { type: 'event', serverId: 's2', envelope: { t: 'sites.state', d: { sites: [] } } });
    expect(s.sites).toEqual([site]);
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'sites.state', d: { sites: [] } } });
    expect(s.sites).toEqual([]);
    expect(enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: welcome({}) }).sites).toEqual([]);
  });
```

Run: `npm test -- apps/desktop/test/renderer/siteModel.test.ts apps/desktop/test/renderer/enterprise.test.ts`
Expected: FAIL — `siteModel.js` does not exist; `s.sites` is undefined.

- [ ] **Step 2: The store**

In `apps/desktop/src/renderer/stores/enterprise.ts`:

- header comment: add "and the company's sites (v0.7.0: every member, those whose channel they see; the welcome's `sites`, then `sites.state`)";
- import `sitesSchemaClient, sitesStateSchemaClient, type Site` from `@ghostlink/shared`;
- `EnterpriseView` gets `/** The sites this person sees (v0.7.0); [] on a normal server or one before 0.7.0. */ sites: Site[];`
- `initialEnterprise` gets `sites: []`;
- the `welcome` case reads `const w = a.welcome as RendererWelcome & { enterprise?: unknown; hermes?: unknown; hermesView?: unknown; sites?: unknown };` and returns `sites: sitesSchemaClient.parse(w.sites)` too (the schema's `.catch([])` covers a missing key);
- in the `event` case, before `return s;`:

```ts
      if (a.envelope.t === 'sites.state') {
        const p = sitesStateSchemaClient.safeParse(a.envelope.d);
        return p.success ? { ...s, sites: p.data.sites } : s;
      }
```

- [ ] **Step 3: `apps/desktop/src/renderer/features/sites/siteModel.ts`**

```ts
// The SITES category (spec 2026-10-03-aba-api-e-sites-design.md §2): who manages it, what it shows, the
// register form's checks. No React and no stores' state, so the tests load it.
import { SITE_LIMITS, normalizeSiteDomain, type Channel, type Edition, type HermesView, type Site } from '@ghostlink/shared';
import { sortedChannels } from '../../stores/channels.js';

/**
 * Who registers, edits and removes sites (plan decision 2): the owner and the page's role (whoever gets
 * the company Hermes's page), in an Enterprise server with the function.
 */
export function canManageSites(o: { supported: boolean; edition: Edition; owner: boolean; view: HermesView | null }): boolean {
  return o.supported && o.edition === 'enterprise' && (o.owner || o.view !== null);
}

/** SITES shows in an Enterprise server with the function, when it has a site or the person manages them. */
export function showSitesSection(o: { supported: boolean; edition: Edition; sites: number; canManage: boolean }): boolean {
  return o.supported && o.edition === 'enterprise' && (o.sites > 0 || o.canManage);
}

/** The sites whose channel this app knows, by name, each with its channel. */
export function siteRows(sites: readonly Site[], channels: Readonly<Record<string, Channel>>): { site: Site; channel: Channel }[] {
  return sites
    .filter((s) => Object.hasOwn(channels, s.channelId))
    .map((site) => ({ site, channel: channels[site.channelId]! }))
    .sort((a, b) => a.site.name.localeCompare(b.site.name, 'pt-BR') || a.site.id.localeCompare(b.site.id));
}

/** A channel list without the channels shown under SITES ("Canais de texto"). */
export function withoutSites(channels: readonly Channel[], sites: readonly Site[]): Channel[] {
  const taken = new Set(sites.map((s) => s.channelId));
  return channels.filter((c) => !taken.has(c.id));
}

/** The text channels a new site may take: not a site yet, in their order. */
export function freeTextChannels(channels: Readonly<Record<string, Channel>>, sites: readonly Site[]): Channel[] {
  return withoutSites(sortedChannels(channels, 'text'), sites);
}

/** Plan decision 3: the free text channels named like a site (a bare domain), for "Cadastrar como sites". */
export function siteLikeChannels(channels: Readonly<Record<string, Channel>>, sites: readonly Site[]): Channel[] {
  return freeTextChannels(channels, sites).filter((c) => normalizeSiteDomain(c.name) === c.name);
}

export type SiteFormProblem = 'name' | 'domain' | 'limit';

/** The register / edit form: what is wrong, or null. `domain` is what the person typed. */
export function siteFormProblem(f: { name: string; domain: string; creating: boolean; count: number }): SiteFormProblem | null {
  if (f.name.trim() === '') return 'name';
  if (normalizeSiteDomain(f.domain) === null) return 'domain';
  if (f.creating && f.count >= SITE_LIMITS.maxSites) return 'limit';
  return null;
}
```

- [ ] **Step 4: `apps/desktop/src/renderer/features/sites/siteActions.ts`**

```ts
import { z } from 'zod';
import { siteSchemaClient, type Channel, type Site } from '@ghostlink/shared';
import { request } from '../chat/actions.js';

const answer = z.object({ site: siteSchemaClient });

/** Registers a site; `channelId` null creates its channel. The server's sites.state updates the sidebar. */
export async function createSite(p: { name: string; domain: string; channelId: string | null }): Promise<Site> {
  return (await request('site.create', p, answer)).site;
}

export async function updateSite(id: string, p: { name: string; domain: string }): Promise<Site> {
  return (await request('site.update', { id, ...p }, answer)).site;
}

/** Removes the site; its channel goes back to "Canais de texto". */
export async function deleteSite(id: string): Promise<void> {
  await request('site.delete', { id }, z.object({}));
}

/** "Cadastrar como sites" (plan decision 3): each channel becomes a site named and addressed after it. Stops at the first refusal. */
export async function registerChannelsAsSites(channels: readonly Channel[]): Promise<void> {
  for (const c of channels) await createSite({ name: c.name, domain: c.name, channelId: c.id });
}
```

- [ ] **Step 5: Run, commit**

Run: `npm test -- apps/desktop/test/renderer/siteModel.test.ts apps/desktop/test/renderer/enterprise.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/features/sites/siteModel.ts apps/desktop/src/renderer/features/sites/siteActions.ts apps/desktop/src/renderer/stores/enterprise.ts apps/desktop/test/renderer/siteModel.test.ts apps/desktop/test/renderer/enterprise.test.ts
git commit -m "feat(desktop): the sites in the enterprise store, and the SITES helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D2: The site items in a channel's menu

**Files:** Modify `apps/desktop/src/renderer/features/channelMenu/{channelMenuModel.ts,ChannelMenu.tsx}`, `apps/desktop/test/renderer/channelMenu.test.ts`.

- [ ] **Step 1: The failing test**

In `channelMenu.test.ts`, inside the first `describe`:

```ts
  it('a site’s channel, for whoever manages sites: edit and remove the site before the channel items', () => {
    expect(channelMenuEntries({ ...base, canManageChannels: true, manageSite: true }).entries).toEqual([
      'markRead',
      'separator', 'pin', 'copyLink',
      'separator', 'mute', 'notify',
      'separator', 'editSite', 'removeSite',
      'separator', 'edit', 'duplicate', 'createText', 'delete',
      'separator', 'copyId',
    ]);
  });
```

Run: `npm test -- apps/desktop/test/renderer/channelMenu.test.ts` → FAIL.

- [ ] **Step 2: The model**

In `channelMenuModel.ts`: add `| 'editSite'` and `| 'removeSite'` to `ChannelMenuEntry`; add to `ChannelMenuFacts`:

```ts
  /** A site's channel and I manage sites (v0.7.0): "Editar site", "Remover site". */
  manageSite?: boolean;
```

and in `channelMenuEntries`, before `if (f.canManageChannels)`:

```ts
  if (f.manageSite) entries.push('separator', 'editSite', 'removeSite');
```

(the doc comment's order gets "| Editar site, Remover site").

- [ ] **Step 3: The menu**

In `ChannelMenu.tsx`, `ChannelMenuProps` gets:

```ts
  /** The channel is a site I manage (v0.7.0): its two items. */
  site?: { onEdit: () => void; onRemove: () => void };
```

destructure `site` in the component, pass `manageSite: site !== undefined` to `channelMenuEntries`, and add two cases to `item`:

```tsx
      case 'editSite':
        return (
          <MenuItem key={entry} onSelect={act(() => site?.onEdit())}>
            {t('sites.edit')}
          </MenuItem>
        );
      case 'removeSite':
        return (
          <MenuItem key={entry} danger onSelect={act(() => site?.onRemove())}>
            {t('sites.remove')}
          </MenuItem>
        );
```

(`sites.edit` and `sites.remove` come in Task D3; until then the typecheck fails only on these two keys, so do D3 Step 4's texts before running the typecheck.)

- [ ] **Step 4: Run** `npm test -- apps/desktop/test/renderer/channelMenu.test.ts` → PASS. Commit with D3.

### Task D3: SITES in the sidebar, the register dialog

**Files:** Create `apps/desktop/src/renderer/features/sites/{SitesSection.tsx,SiteDialog.tsx}`, `apps/desktop/src/renderer/layout/TextChannelRow.tsx`; Modify `apps/desktop/src/renderer/layout/ChannelSidebar.tsx`, `apps/desktop/src/renderer/i18n/sites.{pt-BR,en}.ts`.

- [ ] **Step 1: The text channel row in its own file**

Move `TextRowContext` and `TextChannelRow` out of `ChannelSidebar.tsx` into `apps/desktop/src/renderer/layout/TextChannelRow.tsx`, exported, with two optional props so a site shows its globe and its name (everything else as it was):

```tsx
import type { ReactNode } from 'react';
import { Hash, Lock } from 'lucide-react';
import type { Channel } from '@ghostlink/shared';
import type { SavedServer } from '../../shared/ipcTypes.js';
import { channelPrefsOf, isChannelMuted } from '../features/channelMenu/channelPrefs.js';
import { userMenuTriggers } from '../features/userMenu/triggers.js';
import { useT } from '../i18n/index.js';
import { centerView, isUnread, readMark } from '../stores/channels.js';
import { dispatchText, useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import type { MenuAnchor } from './primitives.js';

/** What a text channel row needs from the sidebar: my choices for it, the time, and its menu. */
export interface TextRowContext {
  saved: SavedServer | null;
  now: number;
  openMenu: (channelId: string, anchor: MenuAnchor) => void;
}

/**
 * A text channel in the sidebar: unread, mentions, muted, its menu on right click. `icon` and `label`
 * replace the # and the channel's name (a site under SITES: the globe and the site's name).
 */
export function TextChannelRow({ channel, context, icon, label }: { channel: Channel; context: TextRowContext; icon?: ReactNode; label?: string }) {
  const t = useT();
  const active = useTextStore((s) => s.channels.activeId === channel.id && centerView(s.channels) === 'chat');
  const mark = useTextStore((s) => readMark(s.channels, channel.id));
  // Muted (its menu): dimmed and never bold; its mentions still count.
  const muted = isChannelMuted(channelPrefsOf(context.saved, channel.id), context.now);
  const unread = !active && !muted && isUnread(channel, mark);
  const mentions = mark.mentionCount;
  const shown = label ?? channel.name;
  const className = [l.channel, muted ? l.channelMuted : '', active ? l.channelActive : '', unread ? l.channelUnread : ''].filter(Boolean).join(' ');
  const triggers = userMenuTriggers((anchor) => context.openMenu(channel.id, anchor));
  const ariaLabel = [
    shown,
    channel.private ? t('layout.privateChannel') : null,
    muted ? t('channelMenu.mutedLabel') : null,
    unread ? t('layout.unread') : null,
    mentions > 0 ? t('layout.mentions', { count: mentions }) : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <li className={l.channelItem}>
      <button
        type="button"
        className={className}
        aria-current={active ? 'page' : undefined}
        aria-label={ariaLabel}
        onClick={() => dispatchText({ type: 'select', channelId: channel.id })}
        {...triggers}
        data-channel={channel.id}
      >
        {icon ?? <Hash className={l.channelIcon} size={18} aria-hidden="true" />}
        <span className={l.channelName}>{shown}</span>
        {channel.private && <Lock className={l.lock} size={13} aria-hidden="true" />}
        {mentions > 0 && (
          <span className={l.mentionBadge} aria-hidden="true">
            {mentions > 99 ? '99+' : mentions}
          </span>
        )}
      </button>
    </li>
  );
}
```

`ChannelSidebar.tsx` imports `TextChannelRow` and `type TextRowContext` from `./TextChannelRow.js` and drops the imports only they used (`Hash`, `channelPrefsOf`, `isChannelMuted`, `userMenuTriggers`, `isUnread`, `readMark`, `centerView` if nothing else uses them: the typecheck and lint say).

- [ ] **Step 2: `SiteDialog.tsx`**

```tsx
import { useMemo, useState, type FormEvent } from 'react';
import { SITE_LIMITS, normalizeSiteDomain, type Site } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, Modal, Select, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { dispatchText, useTextStore } from '../../stores/text.js';
import { createSite, registerChannelsAsSites, updateSite } from './siteActions.js';
import { freeTextChannels, siteFormProblem, siteLikeChannels } from './siteModel.js';

const NEW_CHANNEL = 'new';

/**
 * "Cadastrar site" (spec 2026-10-03-aba-api-e-sites §2): name, address and channel (an existing text
 * channel, or "Criar canal novo" named after the address); above it, the channels named like a site with
 * "Cadastrar como sites" (plan decision 3). With `site`: "Editar site", name and address only.
 */
export function SiteDialog({ site, onClose }: { site?: Site; onClose: () => void }) {
  const t = useT();
  const byId = useTextStore((st) => st.channels.byId);
  const sites = useEnterpriseStore((st) => st.sites);
  const free = useMemo(() => freeTextChannels(byId, sites), [byId, sites]);
  const likely = useMemo(() => (site ? [] : siteLikeChannels(byId, sites)), [site, byId, sites]);
  const [name, setName] = useState(site?.name ?? '');
  const [domain, setDomain] = useState(site?.domain ?? '');
  const [channelId, setChannelId] = useState<string>(NEW_CHANNEL);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = siteFormProblem({ name, domain, creating: site === undefined, count: sites.length });

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      onClose();
    } catch (e) {
      setError(errorCodeOf(e));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem !== null) return;
    const clean = normalizeSiteDomain(domain)!;
    void run(async () => {
      if (site) {
        await updateSite(site.id, { name: name.trim(), domain: clean });
        return;
      }
      const created = await createSite({ name: name.trim(), domain: clean, channelId: channelId === NEW_CHANNEL ? null : channelId });
      dispatchText({ type: 'select', channelId: created.channelId });
    });
  };
  const options = [{ value: NEW_CHANNEL, label: t('sites.newChannel') }, ...free.map((c) => ({ value: c.id, label: `# ${c.name}` }))];

  return (
    <Modal
      title={site ? t('sites.editTitle', { name: site.name }) : t('sites.createTitle')}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="site-form" className={`${p.button} ${p.buttonPrimary}`} disabled={busy}>
            {site ? t('sites.save') : t('sites.create')}
          </button>
        </>
      }
    >
      {likely.length > 0 && (
        <section className={s.field} data-sites-likely>
          <span className={s.label}>{t('sites.likely', { n: likely.length })}</span>
          <p className={s.hint}>{likely.map((c) => `# ${c.name}`).join(' · ')}</p>
          <div className={s.row}>
            <button type="button" className={p.button} disabled={busy || sites.length + likely.length > SITE_LIMITS.maxSites} onClick={() => void run(() => registerChannelsAsSites(likely))}>
              {t('sites.registerLikely')}
            </button>
          </div>
        </section>
      )}
      <form id="site-form" className={s.form} onSubmit={submit}>
        <label className={s.field}>
          <span className={s.label}>{t('sites.name')}</span>
          <input className={s.input} value={name} maxLength={SITE_LIMITS.nameMax} placeholder={t('sites.nameExample')} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className={s.field}>
          <span className={s.label}>{t('sites.domain')}</span>
          <input className={s.input} value={domain} maxLength={300} placeholder={t('sites.domainExample')} spellCheck={false} onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
          <span className={s.hint}>{t('sites.domainHint')}</span>
        </label>
        {!site && (
          <div className={s.field}>
            <span className={s.label} id="site-channel-label">
              {t('sites.channel')}
            </span>
            <Select value={channelId} options={options} onChange={setChannelId} labelledBy="site-channel-label" disabled={busy} />
            <span className={s.hint}>{t(channelId === NEW_CHANNEL ? 'sites.newChannelHint' : 'sites.moveHint')}</span>
          </div>
        )}
        {tried && problem !== null && (
          <p className={p.error} role="alert">
            {t(`sites.problem.${problem}`)}
          </p>
        )}
        {error && <ErrorText code={error} />}
      </form>
    </Modal>
  );
}
```

- [ ] **Step 3: `SitesSection.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import { FEATURE_ENTERPRISE_SITES, type Site } from '@ghostlink/shared';
import type { SavedServer } from '../../../shared/ipcTypes.js';
import { useT } from '../../i18n/index.js';
import l from '../../layout/layout.module.css';
import { ConfirmDialog, type MenuAnchor } from '../../layout/primitives.js';
import { TextChannelRow } from '../../layout/TextChannelRow.js';
import { useConnectionStore } from '../../stores/connection.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { ChannelMenu, type ChannelMenuDialog } from '../channelMenu/ChannelMenu.js';
import { deleteSite } from './siteActions.js';
import { SiteDialog } from './SiteDialog.js';
import { canManageSites, showSitesSection, siteRows } from './siteModel.js';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'remove'; site: Site };

/**
 * SITES, right below BOTS (spec 2026-10-03-aba-api-e-sites §2): each site with a globe and its name; a
 * click opens its text channel like any channel. The owner and the page's role get "+" (Cadastrar site)
 * and, in the channel's menu, "Editar site" and "Remover site".
 */
export function SitesSection({ saved, onOpen }: { saved: SavedServer | null; onOpen: (dialog: ChannelMenuDialog, channelId: string) => void }) {
  const t = useT();
  const serverId = useTextStore((st) => st.server.serverId);
  const supported = useConnectionStore((st) => st.welcome?.serverId === serverId && st.welcome.features.includes(FEATURE_ENTERPRISE_SITES));
  const edition = useEnterpriseStore((st) => st.edition);
  const sites = useEnterpriseStore((st) => st.sites);
  const view = useEnterpriseStore((st) => st.view);
  const owner = useTextStore((st) => isOwner(st.server));
  const byId = useTextStore((st) => st.channels.byId);
  const rows = useMemo(() => siteRows(sites, byId), [sites, byId]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ site: Site; anchor: MenuAnchor } | null>(null);
  const canManage = canManageSites({ supported, edition, owner, view });
  if (!showSitesSection({ supported, edition, sites: rows.length, canManage })) return null;
  const menuChannel = menu && Object.hasOwn(byId, menu.site.channelId) ? byId[menu.site.channelId]! : null;

  return (
    <section className={l.section} aria-labelledby="section-sites" data-sites-section>
      <div className={l.sectionHeader}>
        <h2 id="section-sites" className={l.sectionTitle}>
          {t('sites.section')}
        </h2>
        {canManage && (
          <button type="button" className={l.sectionAdd} onClick={() => setDialog({ kind: 'create' })} aria-label={t('sites.add')} title={t('sites.add')}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className={l.channelList}>
        {rows.map(({ site, channel }) => (
          <TextChannelRow
            key={site.id}
            channel={channel}
            label={site.name}
            icon={<Globe className={l.channelIcon} size={18} aria-hidden="true" />}
            context={{ saved, now: Date.now(), openMenu: (_channelId, anchor) => setMenu({ site, anchor }) }}
          />
        ))}
      </ul>
      {rows.length === 0 && canManage && <p className={l.emptyHint}>{t('sites.empty')}</p>}

      {menu && menuChannel && (
        <ChannelMenu
          channel={menuChannel}
          anchor={menu.anchor}
          saved={saved}
          onClose={() => setMenu(null)}
          onOpen={onOpen}
          site={canManage ? { onEdit: () => setDialog({ kind: 'edit', site: menu.site }), onRemove: () => setDialog({ kind: 'remove', site: menu.site }) } : undefined}
        />
      )}
      {dialog?.kind === 'create' && <SiteDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <SiteDialog site={dialog.site} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title={t('sites.removeTitle', { name: dialog.site.name })}
          body={t('sites.removeBody', { channel: byId[dialog.site.channelId]?.name ?? dialog.site.domain })}
          confirmLabel={t('sites.remove')}
          onConfirm={() => deleteSite(dialog.site.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
```

(Check `ChannelMenuDialog` is exported from `ChannelMenu.tsx` — it is — and that `ConfirmDialog`'s `onConfirm` takes a promise, as the API tab's does.)

- [ ] **Step 4: The texts**

`sites.pt-BR.ts`, the full object:

```ts
export const sites = {
  'sites.section': 'Sites',
  'sites.add': 'Cadastrar site',
  'sites.empty': 'Cadastre os sites da empresa: o Hermes posta no canal de cada um o que fizer nele.',
  'sites.createTitle': 'Cadastrar site',
  'sites.editTitle': 'Editar {name}',
  'sites.name': 'Nome',
  'sites.nameExample': 'Profeta Cristão ES',
  'sites.domain': 'Endereço',
  'sites.domainExample': 'es.profetacristao.com',
  'sites.domainHint': 'Só o domínio, sem caminho e sem senha.',
  'sites.channel': 'Canal',
  'sites.newChannel': 'Criar canal novo',
  'sites.newChannelHint': 'Um canal de texto com o nome do endereço.',
  'sites.moveHint': 'O canal vai para Sites com todo o histórico.',
  'sites.create': 'Cadastrar',
  'sites.save': 'Salvar',
  'sites.likely': 'Canais com nome de site: {n}',
  'sites.registerLikely': 'Cadastrar como sites',
  'sites.edit': 'Editar site',
  'sites.remove': 'Remover site',
  'sites.removeTitle': 'Remover {name} dos sites?',
  'sites.removeBody': 'O canal #{channel} continua, com todo o histórico, e volta para Canais de texto.',
  'sites.problem.name': 'Dê um nome ao site.',
  'sites.problem.domain': 'Use só o domínio, como es.profetacristao.com.',
  'sites.problem.limit': 'O limite é de 50 sites.',
};

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const SITES_SAME_IN_BOTH = ['sites.section', 'sites.nameExample', 'sites.domainExample'] as const;
```

`sites.en.ts`:

```ts
export const sites: Record<keyof typeof sitesPt, string> = {
  'sites.section': 'Sites',
  'sites.add': 'Add site',
  'sites.empty': 'Add the company’s sites: the Hermes posts what it does on each one in its channel.',
  'sites.createTitle': 'Add site',
  'sites.editTitle': 'Edit {name}',
  'sites.name': 'Name',
  'sites.nameExample': 'Profeta Cristão ES',
  'sites.domain': 'Address',
  'sites.domainExample': 'es.profetacristao.com',
  'sites.domainHint': 'Only the domain, no path and no password.',
  'sites.channel': 'Channel',
  'sites.newChannel': 'Create a new channel',
  'sites.newChannelHint': 'A text channel named after the address.',
  'sites.moveHint': 'The channel moves to Sites with all its history.',
  'sites.create': 'Add',
  'sites.save': 'Save',
  'sites.likely': 'Channels named like a site: {n}',
  'sites.registerLikely': 'Add them as sites',
  'sites.edit': 'Edit site',
  'sites.remove': 'Remove site',
  'sites.removeTitle': 'Remove {name} from the sites?',
  'sites.removeBody': 'The #{channel} channel stays, with all its history, and goes back to Text channels.',
  'sites.problem.name': 'Give the site a name.',
  'sites.problem.domain': 'Use only the domain, like es.profetacristao.com.',
  'sites.problem.limit': 'The limit is 50 sites.',
};
```

- [ ] **Step 5: The sidebar**

In `ChannelSidebar.tsx`:

- import `{ SitesSection } from '../features/sites/SitesSection.js'`, `{ withoutSites } from '../features/sites/siteModel.js'` and `useEnterpriseStore`;
- `const sites = useEnterpriseStore((s) => s.sites);` and the text list leaves the sites out:

```ts
  const text = useMemo(() => pinnedFirst(withoutSites(sortedChannels(byId, 'text'), sites), saved?.pinned), [byId, saved, sites]);
```

- right after `<BotsSection />`:

```tsx
        <SitesSection saved={saved} onOpen={onOpen} />
```

- the component's doc comment: "then BOTS, SITES (Enterprise, v0.7.0), the text and the voice channels".

- [ ] **Step 6: Run, check, commit**

Run: `npm test -- apps/desktop/test/renderer/channelMenu.test.ts apps/desktop/test/renderer/siteModel.test.ts apps/desktop/test/renderer/i18n.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/features/sites/SitesSection.tsx apps/desktop/src/renderer/features/sites/SiteDialog.tsx apps/desktop/src/renderer/layout/TextChannelRow.tsx apps/desktop/src/renderer/layout/ChannelSidebar.tsx apps/desktop/src/renderer/features/channelMenu/channelMenuModel.ts apps/desktop/src/renderer/features/channelMenu/ChannelMenu.tsx apps/desktop/src/renderer/i18n/sites.pt-BR.ts apps/desktop/src/renderer/i18n/sites.en.ts apps/desktop/test/renderer/channelMenu.test.ts
git commit -m "feat(desktop): the SITES category below BOTS: register, edit and remove sites

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Track E: the Hermes plugin 1.2

Everything here runs only with `GHOSTLINK_COMPANY=true` (rule 3): `adapter.py` builds the `CompanyAgent`, the `SitesKeeper` and the tools' runtime only then. `company.py` and `sites.py` import nothing from Hermes at load (their checks run without a Hermes install); `sites.py` reaches Hermes's `cron.jobs`, `hermes_time` and `agent.prompt_builder` through guarded imports.

### Task E1: `company.py` — any API key, five AI providers, the report as the server takes it

**Files:** Modify `integrations/hermes-agent/ghostlink/company.py`, `integrations/hermes-agent/test/company_check.py`, `integrations/hermes-agent/test/company.test.ts`.

- [ ] **Step 1: The failing checks**

At the end of `company_check.py`, before `print("ok")`:

```python
# Plugin 1.2 (spec 2026-10-03-aba-api-e-sites §1): any API key by variable, in the environment only; a
# reserved name, an AI's variable and the operator's own variables are never touched; deleted in
# GhostLink, gone here.
apis_env = {"OPERADOR_KEY": "do-railway"}
apis_home = CompanyHome(home, environ=apis_env)  # the operator's: whatever was there at the start
mine = "sk-test-" + secrets.token_hex(12)  # made at run time, never a real key
assert apis_home.set_apis({"MINHA_API_KEY": mine, "PATH": "/tmp", "LD_PRELOAD": "x", "HERMES_HOME": "/x",
                           "OPERADOR_KEY": "outro", "DEEPSEEK_API_KEY": "x", "minha_key": "x"}) == ["MINHA_API_KEY"]
assert apis_env == {"OPERADOR_KEY": "do-railway", "MINHA_API_KEY": mine}
assert apis_home.set_apis({}) == ["MINHA_API_KEY"] and apis_env == {"OPERADOR_KEY": "do-railway"}
assert all(mine not in p.read_text(encoding="utf-8", errors="replace") for p in home.rglob("*") if p.is_file()), "never on disk"

# The five AI providers by Hermes's ids: openai-api reads OPENAI_API_KEY (Hermes's `openai` is OpenRouter's alias).
ai_env = {}
CompanyHome(home, environ=ai_env).apply({**config, "keys": {"openai-api": mine, "gemini": None}})
assert ai_env == {"OPENAI_API_KEY": mine}


# A 1.1-shaped config (no apis, no sites) still applies; the report carries two key results for a server
# before 0.7 and five once its welcome lists enterpriseApis.
async def report_shapes():
    sent.clear()
    agent = CompanyAgent(CompanyHome(home, environ={}), request=request, check_key=check_key)
    await agent.on_event("hermes.config", config)
    assert set(sent[-1][1]["status"]["keys"]) == {"deepseek", "openrouter"}
    agent.features = frozenset({"enterpriseApis"})
    await agent.report()
    assert set(sent[-1][1]["status"]["keys"]) == {"deepseek", "openrouter", "openai-api", "anthropic", "gemini"}


asyncio.run(report_shapes())
```

In `company.test.ts`, a second test keeps the deny lists equal on both sides:

```ts
import { API_ENV_DENIED_NAMES, API_ENV_DENIED_PREFIXES } from '@ghostlink/shared';

const PLUGIN_DIR = fileURLToPath(new URL('../ghostlink/', import.meta.url));

  it('refuses the same variable names as packages/shared (ENV_DENIED_NAMES / ENV_DENIED_PREFIXES)', () => {
    const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(PLUGIN_DIR)}); import company; print(json.dumps([sorted(company.ENV_DENIED_NAMES), list(company.ENV_DENIED_PREFIXES)]))`;
    const r = spawnSync(PYTHON!, ['-c', code], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual([[...API_ENV_DENIED_NAMES].sort(), [...API_ENV_DENIED_PREFIXES]]);
  });
```

Run: `npm test -- integrations/hermes-agent/test/company.test.ts`
Expected: FAIL (or SKIPPED without Python: then CI's Linux job is the check) — `set_apis` does not exist.

- [ ] **Step 2: The providers, the key checks, the deny rule**

In `company.py`, replace `PROVIDER_ENV` and `KEY_CHECK_URLS` with:

```python
# Hermes's model.provider ids and the variable each reads (plan "Facts" 1).
PROVIDER_ENV = {"deepseek": "DEEPSEEK_API_KEY", "openrouter": "OPENROUTER_API_KEY", "openai-api": "OPENAI_API_KEY",
                "anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}
# A GhostLink server before 0.7 takes exactly these two key results in hermes.report.
PROVIDERS_V1 = ("deepseek", "openrouter")
FEATURE_APIS = "enterpriseApis"


def _bearer(key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


# Each provider's free listing (no tokens spent): URL and headers. Gemini answers a bad key with 400.
KEY_CHECKS: Dict[str, Tuple[str, Callable[[str], Dict[str, str]]]] = {
    "deepseek": ("https://api.deepseek.com/models", _bearer),
    "openrouter": ("https://openrouter.ai/api/v1/key", _bearer),
    "openai-api": ("https://api.openai.com/v1/models", _bearer),
    "anthropic": ("https://api.anthropic.com/v1/models", lambda k: {"x-api-key": k, "anthropic-version": "2023-06-01"}),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/models", lambda k: {"x-goog-api-key": k}),
}

# packages/shared/src/companyHermes.ts API_ENV_DENIED_NAMES / API_ENV_DENIED_PREFIXES, the same lists
# (test/company.test.ts compares them): an `apis` key never replaces one of these.
ENV_DENIED_NAMES = frozenset({
    "PATH", "HOME", "USER", "SHELL", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "TERM", "TZ",
    "HOSTNAME", "LOGNAME", "MAIL", "IFS", "ENV", "CDPATH", "PS1", "PS2", "PS4", "PROMPT_COMMAND", "EDITOR", "VISUAL",
    "PAGER", "DISPLAY", "SSH_AUTH_SOCK", "VIRTUAL_ENV",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY",
})
ENV_DENIED_PREFIXES = ("LD_", "DYLD_", "PYTHON", "NODE_", "NPM_", "SSL_", "REQUESTS_CA", "CURL_CA", "GIT_", "PIP_",
                       "UV_", "LC_", "XDG_", "BASH_", "S6_", "RAILWAY_", "TERMINAL_", "GATEWAY_", "HERMES_", "GHOSTLINK_")
_API_ENV = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")


def api_env_ok(name: str) -> bool:
    """An `apis` variable GhostLink may set: the shared rule, and never an AI's (those come in `keys`)."""
    return (bool(_API_ENV.match(name)) and name not in ENV_DENIED_NAMES and not name.startswith(ENV_DENIED_PREFIXES)
            and name not in PROVIDER_ENV.values())


# The environment's names when the gateway loaded this plugin (Railway variables, s6, Hermes's .env): the
# operator's. An `apis` key never replaces or removes one (MACROL_MCP_KEY lives there: plan decision 16).
_OPERATOR_ENV = frozenset(os.environ)
# The `apis` variables this process set, across reconnections (one deleted in GhostLink is removed here).
_MANAGED_APIS: set = set()
```

(the same names and the same prefix order as `packages/shared`'s lists in Task 1 Step 4e; `company.test.ts` compares them.)

The module docstring's first bullet becomes "the AI keys (the five providers of PROVIDER_ENV) and any other API key (`apis`, by variable) go to this process's environment only…".

- [ ] **Step 3: `CompanyHome` keeps the operator's variables and its own**

```python
    def __init__(self, home: Path, environ: MutableMapping[str, str] = os.environ,
                 operator: Optional[frozenset] = None, managed: Optional[set] = None):
        self.home = Path(home)
        self.environ = environ
        self.config_path = self.home / "config.yaml"
        self.backups = self.home / "ghostlink" / "backups"
        own = environ is os.environ
        # A test's environment is all the operator's when it is handed over; the real one was read at import.
        self.operator = operator if operator is not None else (_OPERATOR_ENV if own else frozenset(environ))
        self.managed = managed if managed is not None else (_MANAGED_APIS if own else set())
```

and after `_set_keys`:

```python
    def set_apis(self, apis: Any) -> List[str]:
        """The other API keys (v0.7.0), in this process's environment only: set, changed, or removed once
        GhostLink no longer has them. A reserved name, an AI's variable and the operator's own variables are
        skipped. Returns the variables that changed (names only: never logged with a value)."""
        items = apis.items() if isinstance(apis, dict) else []
        wanted = {str(k): v for k, v in items if isinstance(v, str) and v and api_env_ok(str(k)) and str(k) not in self.operator}
        changed: List[str] = []
        for name in sorted(self.managed - set(wanted)):
            self.environ.pop(name, None)
            self.managed.discard(name)
            changed.append(name)
        for name, value in sorted(wanted.items()):
            if self.environ.get(name) != value:
                self.environ[name] = value
                changed.append(name)
            self.managed.add(name)
        return changed
```

- [ ] **Step 4: `check_key` per provider**

```python
async def check_key(provider: str, key: str, timeout: float = 10.0) -> str:
    """The provider's free listing with the key: 'ok', 'refused' or 'unreachable' (no tokens spent)."""
    import aiohttp
    url, headers = KEY_CHECKS[provider]
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(url, headers=headers(key)) as res:
                if res.status in (401, 403) or (provider == "gemini" and res.status == 400):
                    return "refused"
                return "ok" if res.status == 200 else "unreachable"
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return "unreachable"
```

- [ ] **Step 5: `CompanyAgent`: `apis`, the sites, the report's shape**

`__init__` takes two more arguments and keeps the server's features:

```python
    def __init__(self, home: CompanyHome, request: Request, check_key: KeyCheck = check_key,
                 restart: Optional[Callable[[], Awaitable[None]]] = None, sites: Optional[Any] = None,
                 channel_name: Callable[[str], Optional[str]] = lambda _id: None):
        self.home, self.request, self.check_key, self.restart = home, request, check_key, restart
        # sites.SitesKeeper (adapter.py, company mode only); channel_name: a channel id's name, for its skill.
        self.sites, self.channel_name = sites, channel_name
        # The server's welcome.features (adapter.py sets them): the report's key results follow them.
        self.features: frozenset = frozenset()
        self.active = False  # a hermes.config arrived: this bot is the company Hermes
        self.version = 0
        self.access: Dict[str, Any] = {"roleIds": [], "channels": "all"}
        self.key_status = {p: "missing" for p in PROVIDER_ENV}
        self.unsupported: Optional[str] = None
        self._fingerprint: Optional[Tuple] = None
```

In `_apply`, right after `self.access = …`:

```python
        self.home.set_apis(d.get("apis") or {})  # a 1.1-shaped config has none: every GhostLink variable goes
        if self.sites is not None:
            try:
                await asyncio.to_thread(self.sites.apply, d.get("sites") or [], self.channel_name)
            except Exception as exc:  # the sites never stop the rest
                logger.warning("GhostLink: sites not applied (%s)", type(exc).__name__)
```

`_build_report` becomes (the status's `keys` and `envOverride` follow the server, plan decision 6):

```python
    def _build_report(self) -> Dict[str, Any]:
        primary = fallback = None
        skills: List[Dict[str, Any]] = []
        memory: Dict[str, List[Dict[str, str]]] = {"company": [], "people": []}
        if self.unsupported is not None and self.home.check() is None:
            self.unsupported = None  # readable again
        if self.unsupported is None:
            try:
                primary, fallback = self.home.models()
                skills, memory = self.home.skills(), self.home.memory()
            except (Unsupported, OSError, ValueError) as exc:  # ValueError: not UTF-8
                self.unsupported = _fit(str(exc) or type(exc).__name__, REASON_MAX)
        self._fingerprint = self.home.fingerprint()
        # A server before 0.7 takes exactly the two v1 key results (its schema is strict).
        providers = list(PROVIDER_ENV) if FEATURE_APIS in self.features else list(PROVIDERS_V1)
        return {"appliedVersion": self.version, "skills": skills, "memory": memory,
                "status": {"model": primary, "fallback": fallback, "keys": {p: self.key_status[p] for p in providers},
                           "unsupported": self.unsupported,
                           "envOverride": [p for p in self.home.env_override() if p in providers]}}
```

- [ ] **Step 6: Run, commit**

Run: `npm test -- integrations/hermes-agent/test/company.test.ts`
Expected: PASS (or SKIPPED locally without Python).

```bash
git add integrations/hermes-agent/ghostlink/company.py integrations/hermes-agent/test/company_check.py integrations/hermes-agent/test/company.test.ts
git commit -m "feat(hermes-plugin): any API key in the process environment, five AI providers, the report as the server takes it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E2: `sites.py` — the generated skill, the summary job, the two tools

**Files:** Create `integrations/hermes-agent/ghostlink/sites.py`, `integrations/hermes-agent/test/sites_check.py`, `integrations/hermes-agent/test/sites.test.ts`.

- [ ] **Step 1: The failing check**

`integrations/hermes-agent/test/sites_check.py`:

```python
"""Checks ghostlink/sites.py on a scratch HERMES_HOME (GhostLink spec 2026-10-03-aba-api-e-sites §2, §5): the
generated skill (no secret; gone with the last site), the summary job created, moved and removed through a
fake cron API, its hour in Hermes's timezone, and the two tools against fake channels. No Hermes install and
no network. Prints "ok" at the end."""

import asyncio
import json
import logging
import os
import secrets
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from sites import JOB_NAME, SUMMARY_PROMPT, TOOLSET, SiteTools, SitesKeeper, summary_schedule  # noqa: E402


class FakeCron:
    """cron.jobs as sites.py uses it: list, create, remove."""

    def __init__(self):
        self.jobs, self.n = [], 0

    def list_jobs(self, include_disabled=False):
        return [dict(j) for j in self.jobs]

    def create_job(self, prompt, schedule, name=None, deliver=None, enabled_toolsets=None, **_):
        self.n += 1
        job = {"id": f"j{self.n}", "name": name, "prompt": prompt, "schedule": {"kind": "cron", "expr": schedule},
               "deliver": deliver, "enabled_toolsets": enabled_toolsets}
        self.jobs.append(job)
        return job

    def remove_job(self, job_id):
        self.jobs = [j for j in self.jobs if j["id"] != job_id]
        return True


home = Path(tempfile.mkdtemp(prefix="ghostlink-sites-"))
UTC = datetime(2026, 10, 3, 15, 0, tzinfo=timezone.utc)  # 12:00 in São Paulo
BRT = UTC.astimezone(timezone(timedelta(hours=-3)))
assert summary_schedule(UTC) == "0 2 * * *", "23:00 in São Paulo is 02:00 UTC (no DST in Brazil)"
assert summary_schedule(BRT) == "0 23 * * *"

cron, cleared, clock = FakeCron(), [], {"now": UTC}
keeper = SitesKeeper(home, cron=cron, now=lambda: clock["now"], clear_skill_index=lambda: cleared.append(1))
fake_key = "sk-test-" + secrets.token_hex(12)  # a server bug sending a key next to a site must not reach the skill
sites = [{"id": "S" * 26, "name": "Profeta Cristão ES", "domain": "es.profetacristao.com", "channelId": "C" * 26, "apiKey": fake_key},
         {"id": "T" * 26, "name": "Loja | TC", "domain": "loja.tcflag.com.br", "channelId": "D" * 26}]
names = {"C" * 26: "es.profetacristao.com"}
keeper.apply(sites, lambda cid: names.get(cid))
skill = home / "skills" / "ghostlink" / "ghostlink-sites" / "SKILL.md"
text = skill.read_text(encoding="utf-8")
assert text.startswith("---\nname: ghostlink-sites\n"), text
assert "es.profetacristao.com" in text and "#es.profetacristao.com" in text and "Loja / TC" in text, text
assert fake_key not in text and "apiKey" not in text, "only name, address and channel reach the skill"
assert cleared == [1], "a new skill folder clears Hermes's skill index"
stamp = skill.stat().st_mtime_ns
keeper.apply(sites, lambda cid: names.get(cid))
assert skill.stat().st_mtime_ns == stamp and cleared == [1], "the same sites rewrite nothing"

[job] = cron.jobs
assert job["name"] == JOB_NAME and job["schedule"]["expr"] == "0 2 * * *" and job["deliver"] == "local"
assert job["enabled_toolsets"] == [TOOLSET] and job["prompt"] == SUMMARY_PROMPT and "[SILENT]" in SUMMARY_PROMPT
clock["now"] = BRT  # Hermes's timezone set to São Paulo: the job moves to 23:00, never two of them
keeper.apply(sites, lambda cid: names.get(cid))
assert [j["schedule"]["expr"] for j in cron.jobs] == ["0 23 * * *"]

# The tools, against fake channels: the Hermes is "h"*32.
posted = []


async def send(channel_id, text):
    posted.append((channel_id, text))
    return "41"


today = int(UTC.timestamp() * 1000)
history = {"C" * 26: [
    {"id": 1, "authorId": "h" * 32, "content": "✅ Publiquei o post X https://es.profetacristao.com/x", "createdAt": today},
    {"id": 2, "authorId": "h" * 32, "content": "📋 Resumo do dia", "createdAt": today},
    {"id": 3, "authorId": "u" * 32, "content": "✅ escrito por outra pessoa", "createdAt": today},
    {"id": 4, "authorId": "h" * 32, "content": "⚠️ ontem", "createdAt": today - 86_400_000}], "D" * 26: []}


async def read(channel_id, since_ms):
    return history[channel_id]


tools = SiteTools(keeper, run=asyncio.run, send=send, history=read, self_id=lambda: "h" * 32, now=lambda: UTC)
ok = json.loads(tools.post({"site": "ES.ProfetaCristao.com", "kind": "action", "text": " Publiquei o post X "}))
assert ok["ok"] and posted == [("C" * 26, "✅ Publiquei o post X")], (ok, posted)
assert json.loads(tools.post({"site": "loja | tc", "kind": "error", "text": "Login bloqueado"}))["ok"]
assert posted[-1] == ("D" * 26, "⚠️ Login bloqueado")
assert "error" in json.loads(tools.post({"site": "outro.com", "kind": "action", "text": "x"}))
assert "error" in json.loads(tools.post({"site": "es.profetacristao.com", "kind": "outro", "text": "x"}))
assert "error" in json.loads(tools.post({"site": "es.profetacristao.com", "kind": "action", "text": "  "}))
day = json.loads(tools.activity({}))
assert day["date"] == "2026-10-03"
assert [s["posts"] for s in day["sites"]] == [["✅ Publiquei o post X https://es.profetacristao.com/x"], []], day

# The last site gone: the skill folder and the job go too.
keeper.apply([], lambda cid: None)
assert not skill.parent.exists() and cron.jobs == [] and cleared == [1, 1]
# An older Hermes without cron.jobs: the skill still comes, nothing breaks (its warning is expected).
logging.disable(logging.CRITICAL)
SitesKeeper(home, cron=None, now=lambda: UTC, clear_skill_index=lambda: None).apply(sites, lambda cid: None)
assert skill.exists()
print("ok")
```

`integrations/hermes-agent/test/sites.test.ts`:

```ts
// ghostlink/sites.py on its own (sites_check.py): skipped where Python with ruamel.yaml and aiohttp is
// missing (GHOSTLINK_TEST_PYTHON picks the interpreter; CI's Linux job has one).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./sites_check.py', import.meta.url));

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

describe.skipIf(PYTHON === null)('the company sites on the Hermes side (spec 2026-10-03 §2)', () => {
  it('writes the skill without a secret, keeps the summary job and answers the two tools', () => {
    const r = spawnSync(PYTHON!, [SCRIPT], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  });
});
```

Run: `npm test -- integrations/hermes-agent/test/sites.test.ts`
Expected: FAIL — no `sites.py` (or SKIPPED without Python).

- [ ] **Step 2: `integrations/hermes-agent/ghostlink/sites.py`**

```python
"""The company's sites on the Hermes side (GhostLink spec 2026-10-03-aba-api-e-sites-design.md §2).

GhostLink sends the site list (name, address, channel; never a key) in hermes.config. With it this module:
- writes the generated skill $HERMES_HOME/skills/ghostlink/ghostlink-sites/SKILL.md (no secret) and removes
  it with the last site; Hermes's skill index is cleared when the folder appears or goes;
- keeps one Hermes cron job, "ghostlink-sites-resumo", at 23:00 in São Paulo expressed in Hermes's own
  timezone, through cron.jobs (never by editing jobs.json, which would bypass its lock);
- answers the two tools adapter.py registers: ghostlink_site_post (an action, an error or the day's summary
  in a site's channel) and ghostlink_site_activity (the day's posts, read back from the channels: no
  activity file).
No Hermes import at load (../test/sites_check.py runs it alone); Hermes's modules are reached in guarded
imports.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

TOOLSET = "ghostlink"  # the platform's name: its tools join Hermes's implicit `hermes-ghostlink` bundle
JOB_NAME = "ghostlink-sites-resumo"
SKILL_PARTS = ("skills", "ghostlink", "ghostlink-sites")
SUMMARY_HOUR = 23  # in São Paulo (spec §2)
PREFIX = {"action": "✅", "error": "⚠️", "summary": "📋"}
TEXT_MAX = 1500
SUMMARY_PROMPT = (
    "Resumo do dia dos sites da empresa no GhostLink.\n"
    "1. Chame ghostlink_site_activity.\n"
    "2. Para cada site com ações ou erros hoje, escreva um resumo curto (o que foi feito, o que falhou e os links) "
    "e poste com ghostlink_site_post, kind \"summary\", nesse site.\n"
    "3. Site sem atividade: não poste nada.\n"
    "4. No fim, responda só [SILENT]."
)
POST_SCHEMA = {
    "name": "ghostlink_site_post",
    "description": (
        "Posta no canal do GhostLink de um site da empresa (skill ghostlink-sites): kind \"action\" depois de cada "
        "ação feita no site (o que fez e o link), \"error\" quando algo falhou ou foi bloqueado, \"summary\" para o "
        "resumo do dia. Nunca inclua chaves, senhas ou tokens."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "site": {"type": "string", "description": "O endereço do site (ex.: es.profetacristao.com) ou o nome dele"},
            "kind": {"type": "string", "enum": ["action", "error", "summary"]},
            "text": {"type": "string", "description": "Texto curto em Markdown, até 1500 caracteres"},
        },
        "required": ["site", "kind", "text"],
    },
}
ACTIVITY_SCHEMA = {
    "name": "ghostlink_site_activity",
    "description": "As ações (✅) e os erros (⚠️) que você postou hoje (horário de São Paulo) no canal de cada site da empresa, para o resumo do dia.",
    "parameters": {"type": "object", "properties": {}},
}


def sao_paulo() -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("America/Sao_Paulo")
    except Exception:  # no tz database: Brazil has kept UTC-3 all year since 2019
        return timezone(timedelta(hours=-3), "BRT")


def hermes_now() -> datetime:
    """Now in Hermes's own timezone (HERMES_TIMEZONE, then config.yaml `timezone`, else the server's)."""
    try:
        from hermes_time import now
        return now()
    except Exception:
        return datetime.now().astimezone()


def summary_schedule(now: datetime) -> str:
    """The cron expression, in the timezone of `now` (Hermes's), for 23:00 in São Paulo that day."""
    at = now.astimezone(sao_paulo()).replace(hour=SUMMARY_HOUR, minute=0, second=0, microsecond=0).astimezone(now.tzinfo)
    return f"{at.minute} {at.hour} * * *"


def hermes_cron() -> Optional[Any]:
    try:
        from cron import jobs
        return jobs
    except Exception:
        return None


def clear_skill_index() -> None:
    """New sessions list a skill folder that appeared or went (Hermes caches its skill index in memory)."""
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
    except Exception:  # an older Hermes: skill_view still finds it; the index catches up after a restart
        return
    try:
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except TypeError:
        clear_skills_system_prompt_cache()


def _cell(text: Any) -> str:
    """One table cell: no control characters, no `|`."""
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(text)).replace("|", "/").strip()


def clean_sites(raw: Any) -> List[Dict[str, str]]:
    """Only what the skill and the tools use: id, name, domain, channelId (anything else is dropped)."""
    out = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, dict) and all(isinstance(s.get(k), str) and s.get(k) for k in ("id", "name", "domain", "channelId")):
            out.append({k: s[k] for k in ("id", "name", "domain", "channelId")})
    return out


def skill_text(sites: List[Dict[str, str]], channel_name: Callable[[str], Optional[str]]) -> str:
    lines = [
        "---",
        "name: ghostlink-sites",
        "description: Sites da empresa no GhostLink. Use ao agir num deles, para postar no canal do site o que fez e os erros.",
        "---",
        "",
        "# Sites da empresa (gerado pelo GhostLink: não edite)",
        "",
        "Cada site tem um canal de texto no GhostLink.",
        "",
        "- Depois de **cada ação** que você fizer num destes sites, chame `ghostlink_site_post` com `kind: \"action\"`",
        "  e um resumo curto: o que fez e o link da página.",
        "- Se algo falhar ou for bloqueado no site, chame com `kind: \"error\"` e diga o que aconteceu.",
        "- Nunca escreva chaves, senhas ou tokens nessas mensagens.",
        "- O resumo do dia sai sozinho às 23h (horário de São Paulo), pelo agendamento `ghostlink-sites-resumo`.",
        "",
        "| Site | Endereço | Canal |",
        "|---|---|---|",
    ]
    for s in sites:
        lines.append(f"| {_cell(s['name'])} | {_cell(s['domain'])} | #{_cell(channel_name(s['channelId']) or '—')} |")
    return "\n".join(lines) + "\n"


class SitesKeeper:
    """The sites as GhostLink last sent them, their skill and their summary job."""

    def __init__(self, home: Path, cron: Optional[Any] = None, now: Callable[[], datetime] = hermes_now,
                 clear_skill_index: Callable[[], None] = clear_skill_index):
        self.home, self.cron, self.now, self.clear_skill_index = Path(home), cron, now, clear_skill_index
        self.sites: List[Dict[str, str]] = []

    def apply(self, sites: Any, channel_name: Callable[[str], Optional[str]] = lambda _id: None) -> None:
        self.sites = clean_sites(sites)
        self._skill(channel_name)
        self._job()

    def _skill(self, channel_name: Callable[[str], Optional[str]]) -> None:
        folder = self.home.joinpath(*SKILL_PARTS)
        path = folder / "SKILL.md"
        if not self.sites:
            if folder.exists():
                shutil.rmtree(folder)
                self.clear_skill_index()
            return
        text = skill_text(self.sites, channel_name)
        new = not path.exists()
        if not new and path.read_text(encoding="utf-8") == text:
            return
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / ".SKILL.md.ghostlink.tmp"
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
        if new:
            self.clear_skill_index()

    def _job(self) -> None:
        cron = self.cron
        if cron is None:
            if self.sites:
                logger.warning("GhostLink: this Hermes has no cron.jobs; the sites' daily summary is off")
            return
        mine = [j for j in cron.list_jobs(include_disabled=True) if j.get("name") == JOB_NAME]
        schedule = summary_schedule(self.now()) if self.sites else None
        keep = None
        for job in mine:
            expr = (job.get("schedule") or {}).get("expr") if isinstance(job.get("schedule"), dict) else job.get("schedule")
            same = schedule is not None and expr == schedule and job.get("prompt") == SUMMARY_PROMPT
            if same and keep is None:
                keep = job
            else:
                cron.remove_job(job["id"])  # moved, changed, extra or no more sites: create_job below if needed
        if schedule is not None and keep is None:
            cron.create_job(prompt=SUMMARY_PROMPT, schedule=schedule, name=JOB_NAME, deliver="local", enabled_toolsets=[TOOLSET])


class SiteTools:
    """The two tools' handlers, called from the agent's thread. `run(coro)` runs a coroutine on the adapter's
    loop and waits; `send(channel_id, text)` → message id; `history(channel_id, since_ms)` → messages."""

    def __init__(self, keeper: SitesKeeper, run: Callable[[Any], Any], send: Callable[[str, str], Any],
                 history: Callable[[str, int], Any], self_id: Callable[[], str], now: Callable[[], datetime] = hermes_now):
        self.keeper, self.run, self.send, self.history, self.self_id, self.now = keeper, run, send, history, self_id, now

    def site(self, ref: str) -> Optional[Dict[str, str]]:
        want = ref.strip().casefold()
        return next((s for s in self.keeper.sites if want in (s["domain"].casefold(), s["name"].casefold())), None)

    def post(self, args: Dict[str, Any], **_: Any) -> str:
        site = self.site(str(args.get("site") or ""))
        if site is None:
            return json.dumps({"error": "site desconhecido: veja a skill ghostlink-sites"}, ensure_ascii=False)
        kind = args.get("kind")
        if kind not in PREFIX:
            return json.dumps({"error": "kind é action, error ou summary"}, ensure_ascii=False)
        text = str(args.get("text") or "").strip()[:TEXT_MAX]
        if not text:
            return json.dumps({"error": "texto vazio"}, ensure_ascii=False)
        try:
            message_id = self.run(self.send(site["channelId"], f"{PREFIX[kind]} {text}"))
        except Exception as exc:
            return json.dumps({"error": f"não postou ({getattr(exc, 'code', type(exc).__name__)})"}, ensure_ascii=False)
        return json.dumps({"ok": True, "site": site["domain"], "messageId": message_id})

    def activity(self, args: Dict[str, Any], **_: Any) -> str:
        sp = sao_paulo()
        start = self.now().astimezone(sp).replace(hour=0, minute=0, second=0, microsecond=0)
        since = int(start.timestamp() * 1000)
        me = self.self_id()
        out = []
        for s in self.keeper.sites:
            try:
                messages = self.run(self.history(s["channelId"], since))
            except Exception as exc:
                out.append({"site": s["domain"], "name": s["name"], "error": getattr(exc, "code", type(exc).__name__)})
                continue
            posts = [str(m.get("content") or "") for m in sorted(messages, key=lambda m: int(m.get("id") or 0))
                     if m.get("authorId") == me and int(m.get("createdAt") or 0) >= since
                     and str(m.get("content") or "").startswith((PREFIX["action"], PREFIX["error"]))]
            out.append({"site": s["domain"], "name": s["name"], "posts": posts})
        return json.dumps({"date": start.date().isoformat(), "sites": out}, ensure_ascii=False)


# The tools are registered once (register_site_tools, at plugin load); the adapter hands them the live
# runtime in company mode only. Without it, or without sites, check_fn hides them from the model.
_active: Optional[SiteTools] = None


def set_active_tools(tools: Optional[SiteTools]) -> None:
    global _active
    _active = tools


def _available() -> bool:
    return _active is not None and bool(_active.keeper.sites)


def _post(args: Dict[str, Any], **_: Any) -> str:
    return _active.post(args) if _active is not None else json.dumps({"error": "GhostLink não está conectado"}, ensure_ascii=False)


def _activity(args: Dict[str, Any], **_: Any) -> str:
    return _active.activity(args) if _active is not None else json.dumps({"error": "GhostLink não está conectado"}, ensure_ascii=False)


def register_site_tools(ctx: Any) -> None:
    """Two new tool names, without override: no plugin capability needed (plan "Facts" 3). A Hermes without
    ctx.register_tool still gets the skill and the job, and a warning."""
    register = getattr(ctx, "register_tool", None)
    if register is None:
        logger.warning("GhostLink: this Hermes cannot take plugin tools; the sites' posts are off")
        return
    for schema, handler in ((POST_SCHEMA, _post), (ACTIVITY_SCHEMA, _activity)):
        try:
            register(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler, check_fn=_available)
        except Exception as exc:
            logger.warning("GhostLink: tool %s not registered (%s)", schema["name"], type(exc).__name__)
```

- [ ] **Step 3: Run, commit**

Run: `npm test -- integrations/hermes-agent/test/sites.test.ts`
Expected: PASS (or SKIPPED locally without Python).

```bash
git add integrations/hermes-agent/ghostlink/sites.py integrations/hermes-agent/test/sites_check.py integrations/hermes-agent/test/sites.test.ts
git commit -m "feat(hermes-plugin): the sites skill, the daily summary job and the site tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E3: The adapter wires it; version 1.2.0

**Files:** Modify `integrations/hermes-agent/ghostlink/adapter.py`, `integrations/hermes-agent/ghostlink/plugin.yaml`, `integrations/hermes-agent/README.md`.

- [ ] **Step 1: `adapter.py`**

- imports: `from typing import Any, Dict, List, Optional, Set` and `from .sites import SiteTools, SitesKeeper, hermes_cron, register_site_tools, set_active_tools`;
- `__init__`: `self._loop: Optional[asyncio.AbstractEventLoop] = None`;
- `connect()` builds the keeper with the agent, in company mode only:

```python
        company = company_enabled(self._setting("company", "GHOSTLINK_COMPANY", ""))
        keeper = SitesKeeper(_hermes_home(), cron=hermes_cron()) if company else None
        # Before start(): the first hermes.config arrives right after the welcome.
        # Only when the operator opted in (GHOSTLINK_COMPANY=true); otherwise hermes.* events are ignored.
        self._company = CompanyAgent(
            CompanyHome(_hermes_home()), request=lambda t, d: client.request(t, d), check_key=check_key,
            restart=restart_gateway_s6 if os.environ.get("GHOSTLINK_COMPANY_RESTART") == "s6" else None,
            sites=keeper, channel_name=lambda cid: (self._channels.get(cid) or {}).get("name"),
        ) if company else None
```

and, after `self._client = client`:

```python
        self._loop = asyncio.get_running_loop()
        if keeper is not None:
            set_active_tools(SiteTools(keeper, run=self._run_on_loop, send=self._post_to_site,
                                       history=self._channel_history, self_id=lambda: self._self_id))
```

- `disconnect()`, first lines: `set_active_tools(None)` and `self._loop = None`;
- `_apply_welcome()`, at the end:

```python
        if self._company is not None:  # the report's shape follows the server (company.py)
            self._company.features = frozenset(str(f) for f in welcome.get("features") or [])
```

- a section after `format_message`:

```python
    # --- the sites' tools (sites.py): called from the agent's thread ---

    def _run_on_loop(self, coro: Any, timeout: float = 30.0) -> Any:
        """Runs a coroutine on the gateway loop this adapter lives on, and waits for it."""
        loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is None or running is loop:
            coro.close()
            raise GhostLinkError("CONNECTION_LOST", "GhostLink is not connected" if loop is None else "a tool ran on the gateway loop")
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)

    async def _post_to_site(self, channel_id: str, text: str) -> Optional[str]:
        result = await self.send(channel_id, text)
        if not result.success:
            raise GhostLinkError("NOT_SENT", result.error or "not sent")
        return result.message_id

    async def _channel_history(self, channel_id: str, since_ms: int) -> List[Dict[str, Any]]:
        """The channel's messages back to `since_ms`: at most 4 pages of 50."""
        messages: List[Dict[str, Any]] = []
        before: Optional[int] = None
        for _ in range(4):
            payload: Dict[str, Any] = {"channelId": channel_id, "limit": 50}
            if before is not None:
                payload["before"] = before
            res = await self._require_client().request("msg.history", payload) or {}
            page = [m for m in res.get("messages") or [] if isinstance(m, dict) and m.get("id") is not None]
            messages.extend(page)
            if not page or not res.get("hasMore") or min(int(m.get("createdAt") or 0) for m in page) < since_ms:
                break
            before = min(int(m["id"]) for m in page)
        return messages
```

- `register(ctx)`: after `ctx.register_platform(…)`, `register_site_tools(ctx)`.

- [ ] **Step 2: `plugin.yaml`** — `version: 1.2.0`; the description's last sentence: "In an Enterprise GhostLink server, the bot marked as the company Hermes gets its settings, API keys and sites from GhostLink, and posts what it does on each site in that site's channel."

- [ ] **Step 3: `README.md`**, section "Hermes da empresa":

- the table's first row: "Chaves de API (aba API da página do Hermes: DeepSeek, OpenRouter, OpenAI, Anthropic, Google Gemini, ElevenLabs, Grok, Yunwu e as do dono)" → "Só na memória do processo do gateway, cada uma na sua variável. Nunca em arquivo… As de IA e a da ElevenLabs o próprio Hermes esconde dos comandos de terminal; as outras os scripts das skills leem. Uma variável que já estava no ambiente quando o gateway ligou (variável do Railway) nunca é trocada.";
- a row "Sites" → "A skill `skills/ghostlink/ghostlink-sites/SKILL.md` (gerada, sem segredo), as ferramentas `ghostlink_site_post` e `ghostlink_site_activity` (só aparecem com sites) e o agendamento `ghostlink-sites-resumo` às 23h de São Paulo, no fuso do próprio Hermes.";
- a bullet: "Chave de MCP (ex.: `MACROL_MCP_KEY`): o Hermes conecta os servidores MCP antes de conectar ao GhostLink, então ela fica numa variável do Railway do serviço, não na aba API. Não a coloque também no `.env`, que vale mais.";
- under "Testes": `test/sites_check.py` (o `ghostlink/sites.py` numa pasta de teste).

- [ ] **Step 4: Check, commit**

Run: `npm run lint && npm test -- integrations/hermes-agent/test/company.test.ts integrations/hermes-agent/test/sites.test.ts`
Expected: PASS (or SKIPPED locally without Python). `adapter_check.py` runs only inside a Hermes install (Task R).

```bash
git add integrations/hermes-agent/ghostlink/adapter.py integrations/hermes-agent/ghostlink/plugin.yaml integrations/hermes-agent/README.md
git commit -m "feat(hermes-plugin): 1.2.0 wires the API keys, the sites and their tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Integration (main session, after Tracks A–E)

### Task I1: End to end — a generic key and a site (spec §5 "Ponta a ponta")

**Files:** Modify `integrations/hermes-agent/test/company_e2e.py`, `integrations/hermes-agent/test/company-hermes.test.ts`.

- [ ] **Step 1: The Python side keeps the features and the sites**

In `company_e2e.py`: import `from sites import SitesKeeper`; the `say(...)` of a `hermes.config` reports `env={v: v in os.environ for v in [*PROVIDER_ENV.values(), "MINHA_API_KEY"]}`; `on_welcome` also sets the agent's features:

```python
    def on_welcome(w):
        box.update(welcome=w)
        box["agent"].features = frozenset(w.get("features") or [])
```

and the agent gets `sites=SitesKeeper(Path(os.environ["HERMES_HOME"]), cron=None)` (no Hermes here: the skill only).

- [ ] **Step 2: The test**

In `company-hermes.test.ts`: import `createSitesModule` from `../../../apps/server/src/sites/index.js` and `type Site` from `@ghostlink/shared`; add `createSitesModule()` after `createCompanyHermesModule()` in the fixture; then, before the `config.yaml` checks:

```ts
    // v0.7.0: a key of the owner's own and a site reach the Hermes; the key only in its environment.
    const mine = `sk-test-ok-${randomBytes(12).toString('hex')}`; // fake, made now
    await fx.owner.ok('hermes.update', { apis: { MINHA_API_KEY: { name: 'Minha API', value: mine } } });
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 2)).toMatchObject({ env: { MINHA_API_KEY: true } });
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null });
    await hermes.until((l) => l.event === 'hermes.config' && l.version === 3);
    const skill = readFileSync(join(home, 'skills', 'ghostlink', 'ghostlink-sites', 'SKILL.md'), 'utf8');
    expect(skill).toContain(site.domain);
    expect(skill).not.toContain(mine);
```

and the "never on disk" loop checks both keys:

```ts
    for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      expect(text).not.toContain(aiKey);
      expect(text).not.toContain(mine);
    }
    expect(JSON.stringify(fx.owner.events)).not.toContain(mine);
```

The title of the `it` gains "…, a key of the owner's own and a site".

- [ ] **Step 3: Run, commit**

Run: `npm test -- integrations/hermes-agent/test/company-hermes.test.ts`
Expected: PASS with the Python packages; otherwise SKIPPED and CI runs it.

```bash
git add integrations/hermes-agent/test/company_e2e.py integrations/hermes-agent/test/company-hermes.test.ts
git commit -m "test(hermes-plugin): end to end with a key of the owner's own and a site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task I2: Docs, checklist, release notes, version

- [ ] **Step 1: `apps/server/src/MODULES.md`** — migrations: "`011_apis_and_sites.sql` adds `company_hermes_keys` (every key of the company Hermes by variable; v0.6's two moved there) and `sites`"; the company Hermes section: `apis` in `hermes.update`, `keys`/`apis`/`sites` in `hermes.config`, the 30-key limit and the deny rules, `seesPage` / `useSites` / `sitesChanged`; a new section **Sites** (`src/sites/`, after companyHermes): `site.create/update/delete`, `sites.state` per member by channel visibility, the welcome's `sites`, `TextModule.createTextChannel`; deleting the server: both tables emptied by `eraseDatabase`.

- [ ] **Step 2: `docs/checklist-teste.md`** — a "12. v0.7.0 A aba API e os Sites" block: the API tab only for the owner, after Memória; save a DeepSeek key and see "teste: ok"; save an ElevenLabs key; add "Outra API" and see `PATH` and `HERMES_HOME` refused; delete a key; "Chaves de IA" is gone from the settings; Modelos lists OpenAI/Anthropic/Gemini once they have keys. SITES below BOTS for the owner and the page role (not for others); "Criar canal novo"; an existing channel moves with its history; "Cadastrar como sites" for channels named like a site; Editar and Remover by right click (the channel goes back to "Canais de texto"); a member who cannot see the channel does not see the site; the Hermes posts ✅ after an action and the 23:00 summary.

- [ ] **Step 3: `release-notes/0.7.0.md`** (pt-BR first, then English, as `release-notes/0.6.3.md`): **Aba API** (o catálogo, "Outra API", as chaves só no servidor e na memória do Hermes, o teste das IAs), **Sites** (a categoria, quem cadastra, o que o Hermes posta), the plugin 1.2, servers update themselves.

- [ ] **Step 4: Version 0.7.0** — the same files as the `release: 0.6.3` commit (`package.json` ×5, `package-lock.json`, `docs-site/verificar-downloads.md`, `docs-site/en/verify-downloads.md`) — **only after the owner approves the release**.

- [ ] **Step 5: Commit, push, CI**

```bash
git add apps/server/src/MODULES.md docs/checklist-teste.md release-notes/0.7.0.md
git commit -m "docs: the API tab and the Sites category (v0.7.0)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin v0.7.0-dev
```

Open the PR; CI (Windows, Linux with the Python tests, macOS, package, image) is the gate. The owner approves the release (tag `v0.7.0`).

---

## Task R: The TC Hermes on plugin 1.2 and its site skills (spec §3) — main session **with the owner**, after v0.7.0 is published

Not code. Never print or paste a key, a token, a connection code or a `.env`; secrets go only into the Railway dashboard's Variables (by the owner) or into GhostLink's API tab. Reading the Trismegisto is **read-only**, with the owner's go-ahead.

- [ ] **R1. Preconditions:** the TC Flag server runs 0.7.0 (the owner's app updated it); the owner's app is 0.7.0.
- [ ] **R2. Plugin 1.2:** copy `integrations/hermes-agent/ghostlink/{__init__.py,adapter.py,client.py,company.py,sites.py,plugin.yaml}` **at tag `v0.7.0`** into `/data/plugins/ghostlink/` of the TC Hermes (fetched from `https://raw.githubusercontent.com/gestao-in7eligente/ghostlink/v0.7.0/integrations/hermes-agent/ghostlink/<file>`), comparing each `sha256sum` there with `git show v0.7.0:integrations/hermes-agent/ghostlink/<file> | sha256sum` run locally; restart the gateway. The page's API tab shows DeepSeek and OpenRouter as configured (the 011 migration moved them).
- [ ] **R3. Check on the pinned digest** what "Facts" could not pin to it: the gateway log has no `GhostLink: tool … not registered` and no "no cron.jobs"; `hermes cron list` shows `ghostlink-sites-resumo` once a site exists, at `0 2 * * *` if the container runs UTC (or `0 23 * * *` with `timezone: America/Sao_Paulo`); `config.yaml` has no `platform_toolsets.ghostlink` that would leave out the `ghostlink` toolset (if it has one, add `ghostlink` to it, and to `platform_toolsets.cron` if that key exists, so site jobs the owner creates can post too); `model.provider: openai-api` works after an OpenAI key (if the owner uses OpenAI).
- [ ] **R4. MACROL_MCP_KEY (spec §3's fallback, plan decision 16):** **the owner** puts it in the TC Hermes's Railway Variables (not in `.env`, which would win, and not in the API tab). Claude adds the Macrol Dashboard MCP server to `config.yaml` as the Trismegisto has it (URL and header name read from the Trismegisto's config without reading any value), with the header reading `${MACROL_MCP_KEY}`; redeploy; `hermes mcp list` (or the log) shows it connected.
- [ ] **R5. Sites:** the owner (or the page role) opens SITES → + → "Cadastrar como sites" for the TC Flag channels named like a site, then fixes each site's name; any other site with "Criar canal novo".
- [ ] **R6. The three skills:** read `macrol-sites-dashboard`, `macrol-dashboard-mcp` and `wp-set-user-avatars` in the Trismegisto (names, files, and where each reads a credential) without printing any value; copy them into `/data/skills/` with every written key replaced by a read of its variable (`GROK_API_KEY`, `YUNWU_API_KEY`, `MACROL_MCP_KEY`, or a variable the owner names in "Outra API"); anything that cannot be cleaned safely stays out, and the owner is told which.
- [ ] **R7. Keys:** **the owner** saves the Grok and Yunwu keys (and any "Outra API" the skills need) in the API tab; the AI rows show "teste: ok".
- [ ] **R8. See it work:** ask the TC Hermes for a small action on one site: a ✅ message with the link appears in that site's channel; the next day after 23:00, a 📋 summary appears only in the channels of sites with activity.
- [ ] **R9. Hand-off:** record in the memory notes the plugin version, the sites and which skills were copied or left out, never any secret.
