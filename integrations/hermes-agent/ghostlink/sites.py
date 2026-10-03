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

import asyncio
import json
import logging
import os
import re
import shutil
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

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


class SiteError(Exception):
    """A tool's post or read that did not happen; `code` is all the tool tells the model."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# What adapter.py hands SiteTools (here, because the adapter cannot run without Hermes).

def run_on_loop(loop: Optional[asyncio.AbstractEventLoop], coro: Any, timeout: float = 30.0) -> Any:
    """Runs a coroutine on the gateway loop the adapter lives on, from the agent's thread, and waits."""
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if loop is None or loop.is_closed() or running is loop:  # on the loop itself it would wait on itself
        coro.close()
        raise SiteError("CONNECTION_LOST")
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return future.result(timeout)
    except TimeoutError:
        future.cancel()
        raise SiteError("TIMEOUT") from None


async def post_to_channel(send: Callable[[str, str], Awaitable[Any]], visible: Callable[[str], bool],
                          channel_id: str, text: str) -> Optional[str]:
    """The adapter's send() (a SendResult), only to a text channel the bot sees by its id (send() alone
    would also take a channel's name)."""
    if not visible(channel_id):
        raise SiteError("NOT_FOUND")
    result = await send(channel_id, text)
    if not result.success:
        raise SiteError("NOT_SENT")
    return result.message_id


async def channel_history(request: Callable[[str, Dict[str, Any]], Awaitable[Any]], channel_id: str, since_ms: int,
                          pages: int = 4, limit: int = 50) -> List[Dict[str, Any]]:
    """The channel's messages back to `since_ms` through msg.history: at most `pages` pages of `limit`."""
    messages: List[Dict[str, Any]] = []
    before: Optional[int] = None
    for _ in range(pages):
        payload: Dict[str, Any] = {"channelId": channel_id, "limit": limit}
        if before is not None:
            payload["before"] = before
        res = await request("msg.history", payload) or {}
        page = [m for m in res.get("messages") or [] if isinstance(m, dict) and isinstance(m.get("id"), int)]
        messages.extend(page)
        if not page or not res.get("hasMore") or min(int(m.get("createdAt") or 0) for m in page) < since_ms:
            break
        before = min(m["id"] for m in page)
    return messages


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
