"""Checks ghostlink/company.py on a scratch HERMES_HOME (spec 2026-10-02-enterprise-e-hermes-da-empresa
§3, §6): models, skills, keys only in the environment, backups, an unknown shape refused, memory read and
an item deleted, access decisions. No Hermes install and no network. Prints "ok" at the end."""

import asyncio
import hashlib
import logging
import os
import secrets
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import Timing, reconnect_delay  # noqa: E402
from company import CompanyAgent, CompanyHome, memory_id  # noqa: E402

home = Path(tempfile.mkdtemp(prefix="ghostlink-company-"))
(home / "config.yaml").write_text(
    "# TC Hermes\nmodel:\n  provider: deepseek\n  default: deepseek-v4-pro\n"
    "fallback_model:\n  provider: openrouter\n  model: deepseek/deepseek-v4-pro\n"
    "plugins:\n  enabled: [ghostlink]\n", encoding="utf-8")
for rel, name, desc in (("hermes-agent", "hermes-agent", "Manual"), ("geral/resumo", "resumo", "Resume conversas"),
                        ("geral/resumo/scripts/x", "nao-e-skill", "x"), (".hub/y", "escondida", "x")):
    (home / "skills" / rel).mkdir(parents=True, exist_ok=True)
    (home / "skills" / rel / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\ncorpo\n", encoding="utf-8")
(home / "memories").mkdir()
(home / "memories" / "MEMORY.md").write_text("A TC Flag fabrica bandeiras.\n§\nO estoque fica em Guarulhos.", encoding="utf-8")
(home / "memories" / "USER.md").write_text("Matheus prefere respostas curtas.", encoding="utf-8")

env = {}
company = CompanyHome(home, environ=env)
fake_key = "sk-test-ok-" + secrets.token_hex(12)  # made at run time, never a real key

config = {"version": 1, "keys": {"deepseek": fake_key, "openrouter": None},
          "models": {"primary": {"provider": "deepseek", "model": "deepseek-flash"}, "fallback": None},
          "disabledSkills": ["resumo", "hermes-agent"], "access": {"roleIds": ["R" * 26], "channels": "all"}}
changed = company.apply(config)
text = (home / "config.yaml").read_text(encoding="utf-8")
assert changed == {"config": True, "keys": ["deepseek"]}, changed
assert "# TC Hermes" in text and "default: deepseek-flash" in text and "fallback_model" not in text, text
assert "hermes-agent" not in text.split("disabled:")[1], "the essential skill is never disabled"
assert env == {"DEEPSEEK_API_KEY": fake_key}, "keys only in the environment"
assert all(fake_key not in p.read_text(encoding="utf-8", errors="replace") for p in home.rglob("*") if p.is_file()), "never on disk"
assert len(list((home / "ghostlink" / "backups").glob("config.yaml.*"))) == 1
assert company.apply(config) == {"config": False, "keys": []}, "the same config changes nothing"

# fallback_providers, when the file uses it, takes the fallback; 6 changes keep 5 backups.
(home / "config.yaml").write_text(text + "fallback_providers: []\n", encoding="utf-8")
for i in range(6):
    company.apply({**config, "models": {"primary": {"provider": "deepseek", "model": f"m{i}"},
                                        "fallback": {"provider": "openrouter", "model": "x/y"}}})
assert "provider: openrouter" in (home / "config.yaml").read_text(encoding="utf-8").split("fallback_providers:")[1]
assert len(list((home / "ghostlink" / "backups").glob("config.yaml.*"))) == 5
assert company.models() == ({"provider": "deepseek", "model": "m5"}, {"provider": "openrouter", "model": "x/y"})

# A model name Hermes accepts but the report's schema would not: shortened to its limits (64 / 128).
long_primary = {"provider": "p" * 100, "model": "m" * 300}
(home / "config.yaml").write_text(
    "model:\n  provider: " + long_primary["provider"] + "\n  default: " + long_primary["model"] + "\n"
    "fallback_providers:\n  - provider: " + "q" * 100 + "\n    model: " + "r" * 300 + "\n", encoding="utf-8")
cut_primary, cut_fallback = company.models()
assert len(cut_primary["provider"]) == 64 and cut_primary["provider"].endswith("…"), cut_primary
assert len(cut_primary["model"]) == 128 and len(cut_fallback["provider"]) == 64 and len(cut_fallback["model"]) == 128
(home / "config.yaml").write_text(text + "fallback_providers: []\n", encoding="utf-8")
company.apply({**config, "models": {"primary": {"provider": "deepseek", "model": "m5"},
                                    "fallback": {"provider": "openrouter", "model": "x/y"}}})

# Hermes MERGES fallback_providers then the legacy fallback_model (hermes_cli/fallback_config.py):
# writing "no fallback" must clear both, and the report shows the first valid entry of the merged chain.
(home / "config.yaml").write_text(
    "model:\n  provider: deepseek\n  default: m5\nfallback_providers: []\nfallback_model:\n  provider: openrouter\n  model: legacy/x\n", encoding="utf-8")
assert company.models()[1] == {"provider": "openrouter", "model": "legacy/x"}, "the legacy entry is in Hermes's chain"
company.apply({**config, "models": {"primary": {"provider": "deepseek", "model": "m5"}, "fallback": None}})
assert company.models()[1] is None and "fallback_model" not in (home / "config.yaml").read_text(encoding="utf-8")
(home / "config.yaml").write_text(
    "fallback_providers:\n  - {provider: bad}\n  - {provider: openrouter, model: first/y}\nfallback_model: {provider: openrouter, model: legacy/x}\n", encoding="utf-8")
assert company.models()[1] == {"provider": "openrouter", "model": "first/y"}
(home / "config.yaml").write_text(text + "fallback_providers: []\n", encoding="utf-8")
company.apply({**config, "models": {"primary": {"provider": "deepseek", "model": "m5"},
                                    "fallback": {"provider": "openrouter", "model": "x/y"}}})

skills = company.skills()
assert [s["name"] for s in skills] == ["hermes-agent", "resumo"], skills
assert skills[0]["locked"] and skills[0]["enabled"] and not skills[1]["enabled"]
company.apply({**config, "disabledSkills": None})
assert company.skills()[1]["enabled"] is False, "null keeps Hermes's own list"

memory = company.memory()
assert [m["text"] for m in memory["company"]] == ["A TC Flag fabrica bandeiras.", "O estoque fica em Guarulhos."]
assert memory["people"][0]["id"] == hashlib.sha256("Matheus prefere respostas curtas.".encode()).hexdigest()[:16]
assert company.delete_memory("company", memory_id("O estoque fica em Guarulhos.")) is True
assert (home / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "A TC Flag fabrica bandeiras."
assert company.delete_memory("company", "0" * 16) is False

# Skills off for the ghostlink platform, and lists stored as strings, count as Hermes reads them
# (global list united with skills.platform_disabled.ghostlink; parse_config_string_list).
saved = (home / "config.yaml").read_text(encoding="utf-8")
(home / "config.yaml").write_text(
    "skills:\n  disabled: '[\"resumo\"]'\n  platform_disabled:\n    discord: [hermes-agent]\n", encoding="utf-8")
assert [s["enabled"] for s in company.skills()] == [True, False], "a JSON-string list is read as a list"
(home / "config.yaml").write_text(
    "skills:\n  platform_disabled:\n    ghostlink: [resumo]\n    discord: [hermes-agent]\n", encoding="utf-8")
assert [s["enabled"] for s in company.skills()] == [True, False], "the ghostlink platform list counts"
(home / "config.yaml").write_text(saved, encoding="utf-8")

# .env holding a key wins in Hermes: reported, never read aloud.
(home / ".env").write_text("OPENROUTER_API_KEY=" + "x" * 20 + "\n", encoding="utf-8")
assert company.env_override() == ["openrouter"]

# An unknown shape: nothing applied, nothing changed.
before = (home / "config.yaml").read_bytes()
(home / "config.yaml").write_text("- uma\n- lista\n", encoding="utf-8")
broken = (home / "config.yaml").read_bytes()
assert company.check() is not None
try:
    company.apply({**config, "keys": {"deepseek": "sk-test-ok-" + secrets.token_hex(12), "openrouter": None}})
    raise AssertionError("must refuse")
except Exception as exc:  # Unsupported
    assert type(exc).__name__ == "Unsupported"
assert (home / "config.yaml").read_bytes() == broken and env == {"DEEPSEEK_API_KEY": fake_key}
(home / "config.yaml").write_bytes(before)

# The agent: access decisions, and a report without network.
sent = []


async def request(t, d):
    sent.append((t, d))
    return {}


async def check_key(provider, key):
    return "ok" if key.startswith("sk-test-ok-") else "refused"


async def agent_flow():
    agent = CompanyAgent(company, request=request, check_key=check_key)
    assert await agent.on_event("msg.new", {}) is False
    await agent.on_event("hermes.config", {**config, "version": 7, "access": {"roleIds": ["R" * 26], "channels": ["C" * 26]}})
    assert agent.allows("o" * 32, "o" * 32, []) and agent.allows("a" * 32, "o" * 32, ["R" * 26])
    assert not agent.allows("z" * 32, "o" * 32, ["X" * 26])
    assert agent.listens_in("C" * 26) and not agent.listens_in("D" * 26)
    reports = [d for t, d in sent if t == "hermes.report"]
    assert reports[-1]["appliedVersion"] == 7 and reports[-1]["status"]["keys"]["deepseek"] == "ok", reports[-1]
    assert all(fake_key not in str(d) for _, d in sent), "the report never carries a key"


asyncio.run(agent_flow())

# The pure access decision the adapter applies to every message (Hermes's own allow-all/pairing/allowlist
# paths must not let anyone else in): the owner or a listed role, in a listened channel, when addressed.
agent = CompanyAgent(company, request=request, check_key=check_key)
assert agent.permits("z" * 32, None, []), "not the company Hermes: the adapter's own rules decide"
agent.active = True
agent.access = {"roleIds": ["R" * 26], "channels": ["C" * 26]}
assert agent.permits("o" * 32, "o" * 32, [], "C" * 26, True) and agent.permits("a" * 32, "o" * 32, ["R" * 26], "C" * 26, True)
assert not agent.permits("z" * 32, "o" * 32, ["X" * 26], "C" * 26, True), "an outsider is refused"
assert not agent.permits("o" * 32, "o" * 32, [], "D" * 26, True), "an unlistened channel is refused"

# A report that fails is sent again; a bad memory file never ends watch().
async def flaky():
    logging.disable(logging.CRITICAL)  # the refused reports log a warning on purpose
    calls = []

    async def refuse(t, d):
        calls.append(t)
        raise RuntimeError("RATE_LIMITED")
    a = CompanyAgent(company, request=refuse, check_key=check_key)
    await a.report()
    assert a._fingerprint is None, "a refused report is not remembered as sent"
    (home / "memories" / "USER.md").write_bytes(bytes([0xFF, 0xFE, 0xFA]))
    a.active = True
    await a.report()  # not UTF-8: reported as unsupported, no exception
    assert a.unsupported is not None
    a.unsupported = None
    task = asyncio.create_task(a.watch(every=0.01))
    await asyncio.sleep(0.1)
    assert not task.done(), "watch() survives a failure"
    task.cancel()
    (home / "memories" / "USER.md").write_text("Matheus prefere respostas curtas.", encoding="utf-8")


asyncio.run(flaky())

# ENTERPRISE_REQUIRED waits 2 minutes between tries.
assert reconnect_delay("ENTERPRISE_REQUIRED", 0, Timing(), lambda: 0.5) == 120.0
assert reconnect_delay("CONNECTION_LOST", 0, Timing(), lambda: 0.5) == 1.0
print("ok")
