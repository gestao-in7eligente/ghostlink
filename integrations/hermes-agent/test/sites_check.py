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
import sites as sites_module  # noqa: E402
from sites import JOB_NAME, SUMMARY_PROMPT, TOOLSET, SiteTools, SitesKeeper, skill_text, summary_schedule  # noqa: E402


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
# A name cannot break out of its table cell into the frontmatter or a new line.
hostile = skill_text([{"id": "X" * 26, "name": "x\n---\nname: outra", "domain": "a.com", "channelId": "E" * 26}], lambda cid: "c|d")
assert "\nname: outra" not in hostile and hostile.count("\n---\n") == 1 and "#c/d" in hostile, hostile

[job] = cron.jobs
assert job["name"] == JOB_NAME and job["schedule"]["expr"] == "0 2 * * *" and job["deliver"] == "local"
assert job["enabled_toolsets"] == [TOOLSET] and job["prompt"] == SUMMARY_PROMPT and "[SILENT]" in SUMMARY_PROMPT
clock["now"] = BRT  # Hermes's timezone set to São Paulo: the job moves to 23:00, never two of them
keeper.apply(sites, lambda cid: names.get(cid))
assert [j["schedule"]["expr"] for j in cron.jobs] == ["0 23 * * *"]
cron.create_job(prompt=SUMMARY_PROMPT, schedule="0 23 * * *", name=JOB_NAME, deliver="local", enabled_toolsets=[TOOLSET])
keeper.apply(sites, lambda cid: names.get(cid))
assert len(cron.jobs) == 1, "an extra copy goes"

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
assert "error" in json.loads(tools.post({"site": "C" * 26, "kind": "action", "text": "x"})), "a channel id is not a site"
assert len(posted) == 2, "nothing posted outside a registered site's channel"
day = json.loads(tools.activity({}))
assert day["date"] == "2026-10-03"
assert [s["posts"] for s in day["sites"]] == [["✅ Publiquei o post X https://es.profetacristao.com/x"], []], day

# The tools as Hermes registers them: two new names in the ghostlink toolset, no override; hidden unless the
# adapter handed the runtime over (company mode) and there is a site.
registered = []


class FakeCtx:
    def register_tool(self, **kwargs):
        registered.append(kwargs)


sites_module.register_site_tools(FakeCtx())
assert [r["name"] for r in registered] == ["ghostlink_site_post", "ghostlink_site_activity"]
assert all(r["toolset"] == TOOLSET and not r.get("override") and r["schema"]["name"] == r["name"] for r in registered)
check = registered[0]["check_fn"]
assert check() is False and "error" in json.loads(registered[0]["handler"]({"site": "loja.tcflag.com.br", "kind": "action", "text": "x"}))
sites_module.set_active_tools(tools)
assert check() is True
assert json.loads(registered[0]["handler"]({"site": "loja.tcflag.com.br", "kind": "action", "text": "y"}, task_id="t"))["ok"]
assert json.loads(registered[1]["handler"]({}))["date"] == "2026-10-03"

# The last site gone: the skill folder and the job go too, and the tools hide.
keeper.apply([], lambda cid: None)
assert not skill.parent.exists() and cron.jobs == [] and cleared == [1, 1]
assert check() is False
sites_module.set_active_tools(None)
# An older Hermes without cron.jobs or ctx.register_tool: the skill still comes, nothing breaks (their
# warnings are expected).
logging.disable(logging.CRITICAL)
SitesKeeper(home, cron=None, now=lambda: UTC, clear_skill_index=lambda: None).apply(sites, lambda cid: None)
assert skill.exists()
sites_module.register_site_tools(object())
print("ok")
