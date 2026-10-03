"""The company's own Hermes (GhostLink spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §3).

GhostLink sends `hermes.config` only to the bot marked as the company Hermes, over its pinned TLS session.
This module applies it to $HERMES_HOME and reads back what `hermes.report` tells, with no Hermes imports
(../test/company_check.py runs it alone):

- the AI keys go to this process's environment only (DEEPSEEK_API_KEY, OPENROUTER_API_KEY), never to a
  file: Hermes reads them every turn (hermes_cli.config.get_env_value_prefer_dotenv: $HERMES_HOME/.env
  first, then the environment), and GhostLink sends them again on every connection;
- the models go to config.yaml `model.provider` / `model.default`; the fallback to `fallback_providers`
  when the file has it, else to the legacy `fallback_model`;
- the skills to config.yaml `skills.disabled`, Hermes's own switch (`hermes-agent` is never off); null
  leaves Hermes's own list alone;
- roles and channels stay in memory, in CompanyAgent;
- config.yaml and the memory files are copied to $HERMES_HOME/ghostlink/backups/ before each write (the
  5 newest kept). A file in a shape this module does not know stops everything: "versão do Hermes não
  suportada". Nothing here ever logs a key or the config.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import hashlib
import io
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, MutableMapping, Optional, Tuple

logger = logging.getLogger(__name__)

PLATFORM = "ghostlink"
PROVIDER_MAX, MODEL_MAX = 64, 128
PROVIDER_ENV = {"deepseek": "DEEPSEEK_API_KEY", "openrouter": "OPENROUTER_API_KEY"}
KEY_CHECK_URLS = {"deepseek": "https://api.deepseek.com/models", "openrouter": "https://openrouter.ai/api/v1/key"}
ESSENTIAL_SKILLS = frozenset({"hermes-agent"})
ENTRY_DELIMITER = "\n§\n"
MEMORY_FILES = {"company": "MEMORY.md", "people": "USER.md"}
SKIP_DIRS = frozenset({".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv",
                       "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache",
                       ".mypy_cache", ".ruff_cache", "_org"})
SUPPORT_DIRS = frozenset({"references", "templates", "assets", "scripts"})
BACKUPS_KEPT = 5
# packages/shared/src/companyHermes.ts HERMES_LIMITS (counted in UTF-16 units, as JavaScript does).
MAX_SKILLS, SKILL_NAME_MAX, SKILL_DESCRIPTION_MAX = 200, 64, 200
MAX_MEMORY_ITEMS, MEMORY_ITEM_MAX, REASON_MAX = 60, 1000, 200


class Unsupported(Exception):
    """A Hermes file is not in a shape this plugin knows: nothing is applied."""


def memory_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _fit(text: str, limit: int) -> str:
    """At most `limit` UTF-16 units (JavaScript's string length), with an ellipsis when cut."""
    if len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    while len((text + "…").encode("utf-16-le")) // 2 > limit:
        text = text[:-1]
    return text + "…"


def _round_trip():
    try:
        from ruamel.yaml import YAML
    except ImportError:
        return None
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 4096
    return y


def _load_yaml(text: str) -> Any:
    rt = _round_trip()
    try:
        if rt is not None:
            return rt.load(text)
        import yaml  # PyYAML, for an older Hermes (comments are then lost on write)
        return yaml.safe_load(text)
    except ImportError as exc:
        raise Unsupported("no YAML library (ruamel.yaml or PyYAML)") from exc
    except Exception as exc:  # the parser's own error types
        raise Unsupported(f"config.yaml does not parse ({type(exc).__name__})") from exc


def _dump_yaml(data: Any) -> str:
    rt = _round_trip()
    if rt is not None:
        out = io.StringIO()
        rt.dump(data, out)
        return out.getvalue()
    import yaml
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


def _frontmatter(text: str) -> Dict[str, Any]:
    text = text.removeprefix("\ufeff")
    end = re.search(r"\n---\s*\n", text[3:]) if text.startswith("---") else None
    if not end:
        return {}
    try:
        data = _load_yaml(text[3:end.start() + 3])
    except Unsupported:
        return {}
    return dict(data) if isinstance(data, dict) else {}


def _names(value: Any) -> set:
    """Hermes's parse_config_string_list: a list, a scalar name, or a list stored as a string."""
    if isinstance(value, str):
        if value.strip().startswith("["):
            try:
                parsed = ast.literal_eval(value.strip())
            except (ValueError, SyntaxError):
                parsed = None
            if isinstance(parsed, list):
                value = parsed
            else:
                value = [value]
        else:
            value = [value]
    elif not isinstance(value, (list, tuple, set, frozenset)):
        return set()
    return {str(v).strip() for v in value if str(v).strip()}


def _entries(raw: str) -> List[str]:
    return [e for e in (x.strip() for x in raw.split(ENTRY_DELIMITER)) if e]


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.ghostlink.tmp")
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


@contextlib.contextmanager
def _locked(path: Path):
    """Hermes's own memory lock (tools/memory_tool_store.py): an exclusive lock on <file>.lock."""
    lock = path.with_name(path.name + ".lock")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        except ImportError:  # Windows (a developer's tests)
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        yield
    finally:
        os.close(fd)


class CompanyHome:
    """The files of one Hermes ($HERMES_HOME) as the company Hermes needs them."""

    def __init__(self, home: Path, environ: MutableMapping[str, str] = os.environ):
        self.home = Path(home)
        self.environ = environ
        self.config_path = self.home / "config.yaml"
        self.backups = self.home / "ghostlink" / "backups"

    # ---- config.yaml ----

    def _read_config(self) -> Any:
        if not self.config_path.exists():
            return _load_yaml("{}\n")
        data = _load_yaml(self.config_path.read_text(encoding="utf-8-sig"))
        if data is None:
            return _load_yaml("{}\n")
        if not isinstance(data, dict):
            raise Unsupported("config.yaml is not a mapping")
        if data.get("model") is not None and not isinstance(data.get("model"), (str, dict)):
            raise Unsupported("config.yaml: model")
        for key, kinds in (("fallback_model", (dict, list)), ("fallback_providers", (list,)), ("skills", (dict,))):
            if data.get(key) is not None and not isinstance(data.get(key), kinds):
                raise Unsupported(f"config.yaml: {key}")
        disabled = (data.get("skills") or {}).get("disabled")
        if disabled is not None and not isinstance(disabled, (list, str)):
            raise Unsupported("config.yaml: skills.disabled")
        return data

    def check(self) -> Optional[str]:
        """None when every file is in a known shape, else why not."""
        try:
            self._read_config()
            for name in MEMORY_FILES.values():
                path = self.home / "memories" / name
                if path.exists():
                    path.read_text(encoding="utf-8-sig")
        except Unsupported as exc:
            return str(exc)
        except (OSError, UnicodeDecodeError) as exc:
            return f"unreadable file ({type(exc).__name__})"
        return None

    def apply(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Models and skills into config.yaml, keys into the environment. Raises Unsupported first,
        before anything changes."""
        if (reason := self.check()) is not None:
            raise Unsupported(reason)
        data = self._read_config()
        before = _dump_yaml(data)
        models = config.get("models") or {}
        primary, fallback = models.get("primary"), models.get("fallback")
        if primary:
            model = data.get("model")
            if not isinstance(model, dict):
                data["model"] = model = _load_yaml("{}\n")
            model["provider"], model["default"] = primary["provider"], primary["model"]
        if "fallback_providers" in data:
            data["fallback_providers"] = [{"provider": fallback["provider"], "model": fallback["model"]}] if fallback else []
            data.pop("fallback_model", None)  # Hermes merges both keys: a legacy entry would stay in its chain
        elif fallback:
            data["fallback_model"] = {"provider": fallback["provider"], "model": fallback["model"]}
        else:
            data.pop("fallback_model", None)
        if config.get("disabledSkills") is not None:
            skills = data.get("skills")
            if not isinstance(skills, dict):
                data["skills"] = skills = _load_yaml("{}\n")
            skills["disabled"] = sorted(_names(config["disabledSkills"]) - ESSENTIAL_SKILLS)
            if isinstance(skills.get("platform_disabled"), dict):  # GhostLink's list is authoritative
                skills["platform_disabled"].pop(PLATFORM, None)
        after = _dump_yaml(data)
        changed = after != before
        if changed:
            if self.config_path.exists():
                self._backup(self.config_path)
            _write_atomic(self.config_path, after)
        return {"config": changed, "keys": self._set_keys(config.get("keys") or {})}

    def _set_keys(self, keys: Dict[str, Optional[str]]) -> List[str]:
        """The AI keys, in this process's environment only. Returns the providers whose key changed."""
        changed = []
        for provider, var in PROVIDER_ENV.items():
            value = keys.get(provider)
            if value:
                if self.environ.get(var) != value:
                    self.environ[var] = value
                    changed.append(provider)
            elif var in self.environ:
                del self.environ[var]
                changed.append(provider)
        return changed

    def env_override(self) -> List[str]:
        """Providers whose key is also in $HERMES_HOME/.env, which Hermes prefers (names only, never values)."""
        try:
            lines = (self.home / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines()
        except OSError:
            return []
        return [p for p, var in PROVIDER_ENV.items()
                if any(re.match(rf"^\s*(export\s+)?{var}\s*=\s*\S", line) for line in lines)]

    def models(self) -> Tuple[Optional[Dict[str, str]], Optional[Dict[str, str]]]:
        data = self._read_config()
        model = data.get("model")
        primary = None
        if isinstance(model, dict) and model.get("default"):
            primary = {"provider": _fit(str(model.get("provider") or ""), PROVIDER_MAX), "model": _fit(str(model["default"]), MODEL_MAX)}
        elif isinstance(model, str) and model:
            primary = {"provider": "", "model": _fit(model, MODEL_MAX)}
        fallback = None
        # Hermes's chain (hermes_cli/fallback_config.py) is fallback_providers, then the legacy fallback_model.
        for raw in (data.get("fallback_providers"), data.get("fallback_model")):
            for entry in [raw] if isinstance(raw, dict) else raw if isinstance(raw, list) else []:
                provider = str(entry.get("provider") or "").strip() if isinstance(entry, dict) else ""
                model_name = str(entry.get("model") or "").strip() if isinstance(entry, dict) else ""
                if provider and model_name and fallback is None:
                    fallback = {"provider": _fit(provider, PROVIDER_MAX), "model": _fit(model_name, MODEL_MAX)}
        return primary, fallback

    # ---- skills and memory ----

    def skills(self) -> List[Dict[str, Any]]:
        cfg = self._read_config().get("skills") or {}
        # Hermes (agent/skill_utils.get_disabled_skill_names): the global list united with this platform's.
        platform_off = cfg.get("platform_disabled")
        disabled = _names(cfg.get("disabled")) | _names(platform_off.get(PLATFORM) if isinstance(platform_off, dict) else None)
        found = []
        for dirpath, dirnames, filenames in os.walk(self.home / "skills"):
            is_skill = "SKILL.md" in filenames
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not (is_skill and d in SUPPORT_DIRS))
            if not is_skill:
                continue
            meta = _frontmatter((Path(dirpath) / "SKILL.md").read_text(encoding="utf-8-sig", errors="replace"))
            name = re.sub(r"[\x00-\x1f\x7f]", "", str(meta.get("name") or Path(dirpath).name)).strip()
            if not name:
                continue
            locked = name in ESSENTIAL_SKILLS
            found.append({"name": _fit(name, SKILL_NAME_MAX), "description": _fit(" ".join(str(meta.get("description") or "").split()), SKILL_DESCRIPTION_MAX),
                          "enabled": locked or name not in disabled, "locked": locked})
        found.sort(key=lambda s: s["name"].lower())
        return found[:MAX_SKILLS]

    def memory(self) -> Dict[str, List[Dict[str, str]]]:
        out = {}
        for target, name in MEMORY_FILES.items():
            try:
                raw = (self.home / "memories" / name).read_text(encoding="utf-8-sig")
            except FileNotFoundError:
                raw = ""
            items = list(dict.fromkeys(_entries(raw)))[:MAX_MEMORY_ITEMS]
            out[target] = [{"id": memory_id(t), "text": _fit(t, MEMORY_ITEM_MAX)} for t in items]
        return out

    def delete_memory(self, target: str, item_id: str) -> bool:
        """Removes the entry with that id (under Hermes's lock). False when there is none."""
        path = self.home / "memories" / MEMORY_FILES[target]
        if not path.exists():
            return False
        with _locked(path):
            raw = path.read_text(encoding="utf-8-sig")
            entries = _entries(raw)
            if raw.strip() and raw.strip() != ENTRY_DELIMITER.join(entries):
                raise Unsupported(f"{path.name} was edited outside Hermes")
            kept = [e for e in entries if memory_id(e) != item_id]
            if len(kept) == len(entries):
                return False
            self._backup(path)
            _write_atomic(path, ENTRY_DELIMITER.join(kept))
        return True

    def fingerprint(self) -> Tuple:
        """What the report shows changed when this does (mtime and size of each file it reads)."""
        paths = [self.config_path, *(self.home / "memories" / n for n in MEMORY_FILES.values())]
        root = self.home / "skills"
        if root.exists():
            paths.extend(sorted(root.rglob("SKILL.md")))
        out = []
        for p in paths:
            try:
                st = p.stat()
                out.append((str(p), st.st_mtime_ns, st.st_size))
            except OSError:
                out.append((str(p), None, None))
        return tuple(out)

    def _backup(self, path: Path) -> None:
        """A copy named by its UTC time (sortable, unique even within one clock tick); the 5 newest stay."""
        self.backups.mkdir(parents=True, exist_ok=True)
        ns = time.time_ns()
        while True:
            seconds = time.strftime("%Y%m%dT%H%M%S", time.gmtime(ns // 1_000_000_000))
            target = self.backups / f"{path.name}.{seconds}{ns % 1_000_000_000:09d}"
            if not target.exists():
                break
            ns += 1
        shutil.copy2(path, target)
        for stale in sorted(self.backups.glob(f"{path.name}.*"))[:-BACKUPS_KEPT]:
            stale.unlink(missing_ok=True)


KeyCheck = Callable[[str, str], Awaitable[str]]
Request = Callable[[str, Dict[str, Any]], Awaitable[Any]]


async def check_key(provider: str, key: str, timeout: float = 10.0) -> str:
    """The provider's free listing with the key: 'ok', 'refused' or 'unreachable' (no tokens spent)."""
    import aiohttp
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(KEY_CHECK_URLS[provider], headers={"Authorization": f"Bearer {key}"}) as res:
                if res.status in (401, 403):
                    return "refused"
                return "ok" if res.status == 200 else "unreachable"
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return "unreachable"


async def restart_gateway_s6() -> None:
    """GHOSTLINK_COMPANY_RESTART=s6: for a Hermes that reads its config only at start. This process
    ends with it; GhostLink sends the keys again when the plugin reconnects."""
    proc = await asyncio.create_subprocess_exec("/command/s6-svc", "-r", "/run/service/gateway-default")
    await proc.wait()


class CompanyAgent:
    """The company Hermes's side of the protocol: applies `hermes.config`, deletes a memory item on
    `hermes.memory.delete`, sends `hermes.report` (at once, after the key checks, and when skills or
    memory change), and answers the adapter's access questions."""

    def __init__(self, home: CompanyHome, request: Request, check_key: KeyCheck = check_key,
                 restart: Optional[Callable[[], Awaitable[None]]] = None):
        self.home, self.request, self.check_key, self.restart = home, request, check_key, restart
        self.active = False  # a hermes.config arrived: this bot is the company Hermes
        self.version = 0
        self.access: Dict[str, Any] = {"roleIds": [], "channels": "all"}
        self.key_status = {p: "missing" for p in PROVIDER_ENV}
        self.unsupported: Optional[str] = None
        self._fingerprint: Optional[Tuple] = None

    async def on_event(self, t: str, d: Dict[str, Any]) -> bool:
        """True when the event was the company Hermes's (the adapter then stops there)."""
        if t == "hermes.config":
            await self._apply(d)
            return True
        if t == "hermes.memory.delete":
            try:
                await asyncio.to_thread(self.home.delete_memory, str(d.get("target")), str(d.get("id")))
            except (Unsupported, KeyError, OSError) as exc:
                logger.warning("GhostLink: memory item not deleted: %s", type(exc).__name__)
            await self.report()
            return True
        return False

    async def _apply(self, d: Dict[str, Any]) -> None:
        self.active = True
        keys = d.get("keys") or {}
        try:
            changed = await asyncio.to_thread(self.home.apply, d)
        except (Unsupported, OSError) as exc:
            self.unsupported = _fit(str(exc) or type(exc).__name__, REASON_MAX)
            logger.error("GhostLink: Hermes version not supported (%s); nothing applied", self.unsupported)
            await self.report()
            return
        self.unsupported = None
        self.version = int(d.get("version") or 0)
        self.access = d.get("access") or {"roleIds": [], "channels": "all"}
        for p in PROVIDER_ENV:
            if not keys.get(p):
                self.key_status[p] = "missing"
            elif p in changed["keys"] or self.key_status[p] == "missing":
                self.key_status[p] = "unchecked"
        await self.report()
        pending = [p for p in PROVIDER_ENV if self.key_status[p] == "unchecked"]
        if pending:
            results = await asyncio.gather(*(self.check_key(p, keys[p]) for p in pending))
            self.key_status.update(zip(pending, results))
            await self.report()
        if changed["config"] and self.restart is not None:
            await self.restart()

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
        return {"appliedVersion": self.version, "skills": skills, "memory": memory,
                "status": {"model": primary, "fallback": fallback, "keys": dict(self.key_status),
                           "unsupported": self.unsupported, "envOverride": self.home.env_override()}}

    async def report(self) -> None:
        payload = await asyncio.to_thread(self._build_report)
        try:
            await self.request("hermes.report", payload)
        except Exception as exc:  # the next change or reconnection reports again
            self._fingerprint = None  # so watch() sends it again
            logger.warning("GhostLink: hermes.report failed (%s)", getattr(exc, "code", type(exc).__name__))

    async def watch(self, every: float = 60.0) -> None:
        """Reports again when Hermes itself changed a skill or its memory."""
        while True:
            await asyncio.sleep(every)
            try:
                if self.active and await asyncio.to_thread(self.home.fingerprint) != self._fingerprint:
                    await self.report()
            except Exception as exc:  # one failure never ends the watch
                logger.warning("GhostLink: report check failed (%s)", type(exc).__name__)

    # ---- access (spec §2 "Quem pode usar") ----

    def allows(self, user_id: str, owner_id: Optional[str], role_ids: List[str]) -> bool:
        if user_id and user_id == owner_id:
            return True
        return bool(set(self.access.get("roleIds") or []).intersection(role_ids))

    def permits(self, user_id: str, owner_id: Optional[str], role_ids: List[str],
                channel_id: str = "", addressed: bool = True) -> bool:
        """The gate for every incoming message. Not the company Hermes: True (the adapter's own rules
        decide). Else only the owner or a listed role, in a listened channel, when addressed: Hermes's
        own paths (allow-all, pairing, allowed users) must not let anyone else in."""
        if not self.active:
            return True
        return addressed and self.listens_in(channel_id) and self.allows(user_id, owner_id, role_ids)

    def listens_in(self, channel_id: str) -> bool:
        channels = self.access.get("channels", "all")
        return channels == "all" or channel_id in channels
