"""GhostLink gateway adapter for Hermes Agent, as a user plugin (``$HERMES_HOME/plugins/ghostlink``).

GhostLink (https://github.com/gestao-in7eligente/ghostlink) is a self-hosted chat like Discord. A bot
joins one GhostLink server with the connection code the app shows once when the bot is created
(BOTS > + Adicionar bot), then reads and writes the text channels its roles let it see.

Environment variables (or the ``ghostlink:`` section of config.yaml, env wins):
    GHOSTLINK_BOT                     connection code: ghostlink-bot://host:port?pin=…&token=…
    GHOSTLINK_ALLOWED_ROLES           role names or ids whose members may talk to Hermes
    GHOSTLINK_ALLOWED_USERS           GhostLink user ids (32 hex) allowed to talk to Hermes
    GHOSTLINK_ALLOW_OWNER             the server's owner may talk to Hermes (default true)
    GHOSTLINK_ALLOW_ALL_USERS         anyone in the server (not recommended: Hermes has a terminal)
    GHOSTLINK_REQUIRE_MENTION         answer only when @mentioned or replied to (default true)
    GHOSTLINK_FREE_RESPONSE_CHANNELS  channels (names or ids) where no mention is needed
    GHOSTLINK_ALLOWED_CHANNELS        if set, the only channels (names or ids) Hermes listens to
    GHOSTLINK_HOME_CHANNEL            channel (name or id) for cron and notification delivery
Everyone else is ignored: Hermes's gateway denies users no allowlist names (default deny).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Dict, Optional, Set

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import (
    apply_yaml_bridge as _apply_yaml_bridge,
    env_is_connected as _env_is_connected,
    extra_or_secret as _extra_or_secret,
    get_scoped_secret as _get_scoped_secret,
)
from gateway.platforms.base import BasePlatformAdapter, SendResult, resolve_channel_prompt
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator

from .company import CompanyAgent, CompanyHome, check_key, company_enabled, ignored_hermes_event, restart_gateway_s6
from .client import FATAL_CODES, GhostLinkBotClient, GhostLinkError, parse_connection_code

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ghostlink"
MAX_MESSAGE_LENGTH = 4000  # CHAT_LIMITS.messageMaxLength
TYPING_INTERVAL_S = 3.0  # the server takes one typing per user per 3 s

_USER_MENTION = re.compile(r"<@([0-9a-f]{32})>")
_ROLE_MENTION = re.compile(r"<@&([A-Z2-7]{26})>")
_RETRYABLE = frozenset({"RATE_LIMITED", "CONNECTION_LOST", "TIMEOUT", "INTERNAL", "UNREACHABLE"})

PLATFORM_HINT = (
    "You are on GhostLink, a self-hosted chat like Discord, in a server's text channel. Messages "
    "render Markdown (bold, italics, code blocks, links) and are capped at 4000 characters. A person "
    "is mentioned as <@userId>. Files cannot be sent here yet: share links instead."
)


def _truthy(value: Any, default: bool) -> bool:
    text = str(value).strip().lower()
    if not text:
        return default
    return text not in {"false", "0", "no", "off"}


def _name_set(raw: Any) -> Set[str]:
    """A list or comma-separated string of names/ids, lowercased, without a leading '#' or '@'."""
    items = raw if isinstance(raw, list) else str(raw or "").split(",")
    return {str(i).strip().lstrip("#@").strip().lower() for i in items if str(i).strip().lstrip("#@").strip()}


def _message_number(value: Any) -> Optional[int]:
    try:
        number = int(str(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _failure(exc: GhostLinkError) -> SendResult:
    retryable = exc.code in _RETRYABLE
    return SendResult(success=False, error=str(exc), retryable=retryable,
                      retry_after=1.0 if exc.code == "RATE_LIMITED" else None)


def check_ghostlink_requirements() -> bool:
    try:
        import aiohttp  # noqa: F401
        import cryptography  # noqa: F401
        return True
    except ImportError:
        logger.warning("GhostLink: aiohttp and cryptography are required")
        return False


def _code_text(config: Any) -> str:
    return str(getattr(config, "token", None) or _get_scoped_secret("GHOSTLINK_BOT", "") or "").strip()


def validate_ghostlink_config(config: PlatformConfig) -> bool:
    try:
        parse_connection_code(_code_text(config))
        return True
    except ValueError:
        logger.warning("GhostLink: GHOSTLINK_BOT is not a connection code (copy it from the app: BOTS > + Adicionar bot)")
        return False


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


class GhostLinkAdapter(BasePlatformAdapter):
    """Gateway adapter for one GhostLink server, as its bot member."""

    splits_long_messages = True  # send() chunks via truncate_message(MAX_MESSAGE_LENGTH)
    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform(PLATFORM_NAME))
        self._client: Optional[GhostLinkBotClient] = None
        self._self_id = ""
        self._self_name = ""
        self._server_id = ""
        self._server_name = "GhostLink"
        self._owner_id: Optional[str] = None
        self._channels: Dict[str, Dict[str, Any]] = {}  # text channels the bot sees, by id
        self._members: Dict[str, Dict[str, Any]] = {}  # by userId
        self._roles: Dict[str, str] = {}  # role id -> name
        self._last_typing: Dict[str, float] = {}
        self._dedup = MessageDeduplicator()
        self._company: Optional[CompanyAgent] = None
        self._company_watch: Optional[asyncio.Task] = None

    # --- settings ---

    def _setting(self, key: str, env: str, default: Any = "") -> Any:
        return _extra_or_secret(self.config.extra, key, env, default, blank_is_unset=False)

    def _role_authorized(self, user_id: str) -> bool:
        """The owner (unless GHOSTLINK_ALLOW_OWNER=false) and members of GHOSTLINK_ALLOWED_ROLES pass as
        adapter-verified role auth, like Discord's allowed roles; GHOSTLINK_ALLOWED_USERS goes through
        Hermes's own allowlist. In the company Hermes (an Enterprise server) GhostLink's roles decide."""
        company = self._company
        if company is not None and company.active:
            return company.allows(user_id, self._owner_id, list((self._members.get(user_id) or {}).get("roleIds") or []))
        if _truthy(self._setting("allow_owner", "GHOSTLINK_ALLOW_OWNER", "true"), True) and user_id == self._owner_id:
            return True
        wanted = _name_set(self._setting("allowed_roles", "GHOSTLINK_ALLOWED_ROLES"))
        if not wanted:
            return False
        for role_id in (self._members.get(user_id) or {}).get("roleIds") or []:
            if str(role_id).lower() in wanted or self._roles.get(role_id, "").strip().lower() in wanted:
                return True
        return False

    def _channel_in(self, channel_id: str, names: Set[str]) -> bool:
        name = str((self._channels.get(channel_id) or {}).get("name") or "").lower()
        return channel_id.lower() in names or (bool(name) and name in names)

    def _addressed(self, channel_id: str, addressed: bool) -> bool:
        """GHOSTLINK_ALLOWED_CHANNELS first, then the mention gate (off in free-response channels)."""
        company = self._company
        if company is not None and company.active:  # spec §2: only when mentioned or replied to
            return addressed and company.listens_in(channel_id)
        allowed = _name_set(self._setting("allowed_channels", "GHOSTLINK_ALLOWED_CHANNELS"))
        if allowed and not self._channel_in(channel_id, allowed):
            return False
        if addressed or not _truthy(self._setting("require_mention", "GHOSTLINK_REQUIRE_MENTION", "true"), True):
            return True
        return self._channel_in(channel_id, _name_set(self._setting("free_response_channels", "GHOSTLINK_FREE_RESPONSE_CHANNELS")))

    def _resolve_channel(self, chat_id: Any) -> Optional[str]:
        """A channel id, or a name ("geral" or "#geral", as GHOSTLINK_HOME_CHANNEL may hold)."""
        text = str(chat_id or "").strip()
        if text in self._channels:
            return text
        wanted = text.lstrip("#").strip().lower()
        for cid, channel in self._channels.items():
            if cid.lower() == wanted or str(channel.get("name") or "").lower() == wanted:
                return cid
        return None

    # --- connection ---

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        try:
            code = parse_connection_code(_code_text(self.config))
        except ValueError as exc:
            logger.error("GhostLink: %s. Copy the code again from the app (BOTS > the bot > Gerar novo código)", exc)
            self._set_fatal_error("ghostlink_bad_code", f"GHOSTLINK_BOT: {exc}", retryable=False)
            return False
        client = GhostLinkBotClient(code, on_event=self._on_event, on_welcome=self._apply_welcome, on_fatal=self._on_fatal)
        # Before start(): the first hermes.config arrives right after the welcome.
        # Only when the operator opted in (GHOSTLINK_COMPANY=true); otherwise hermes.* events are ignored.
        self._company = CompanyAgent(
            CompanyHome(_hermes_home()), request=lambda t, d: client.request(t, d), check_key=check_key,
            restart=restart_gateway_s6 if os.environ.get("GHOSTLINK_COMPANY_RESTART") == "s6" else None,
        ) if company_enabled(self._setting("company", "GHOSTLINK_COMPANY", "")) else None
        try:
            await client.start()
        except GhostLinkError as exc:
            logger.error("GhostLink: could not connect to %s: %s", code.address, exc)
            if exc.code in FATAL_CODES:
                self._set_fatal_error(f"ghostlink_{exc.code.lower()}", str(exc), retryable=False)
            elif exc.code == "ENTERPRISE_REQUIRED":
                self._set_fatal_error("ghostlink_enterprise_required", str(exc), retryable=True)
            return False
        self._client = client
        if self._company is not None:
            self._company_watch = asyncio.create_task(self._company.watch(), name="ghostlink-company")
        self._mark_connected()
        self._wire_plugin_handlers(None)
        logger.info("GhostLink: connected to %s (%s) as %s, %d text channels",
                    self._server_name, code.address, self._self_name, len(self._channels))
        return True

    async def disconnect(self) -> None:
        client, self._client = self._client, None
        watch, self._company_watch = self._company_watch, None
        if watch is not None:
            watch.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watch
        if client is not None:
            await client.close()
        self._mark_disconnected()
        logger.info("GhostLink: disconnected")

    async def _on_fatal(self, exc: GhostLinkError) -> None:
        self._set_fatal_error(f"ghostlink_{exc.code.lower()}", str(exc), retryable=False)
        await self._notify_fatal_error()

    def _apply_welcome(self, welcome: Dict[str, Any]) -> None:
        me = welcome.get("self") or {}
        self._self_id = str(me.get("userId") or "")
        self._self_name = str(me.get("nickname") or "Hermes")
        server = welcome.get("server") or {}
        self._server_id = str(server.get("serverKeyId") or "")
        self._server_name = str(server.get("name") or "GhostLink")
        self._owner_id = (welcome.get("serverSettings") or {}).get("ownerId")
        self._channels = {str(c["id"]): c for c in welcome.get("channels") or []
                          if isinstance(c, dict) and c.get("id") and c.get("type") == "text"}
        self._roles = {str(r["id"]): str(r.get("name") or "") for r in welcome.get("roles") or []
                       if isinstance(r, dict) and r.get("id")}
        self._members = {str(m["userId"]): m for m in welcome.get("members") or []
                         if isinstance(m, dict) and m.get("userId")}

    # --- events ---

    async def _on_event(self, t: str, d: Dict[str, Any]) -> None:
        if ignored_hermes_event(self._company is not None, t):
            logger.debug("GhostLink: %s ignored (GHOSTLINK_COMPANY is not on)", t)
            return
        if self._company is not None and await self._company.on_event(t, d):
            return
        if t == "msg.new":
            await self._on_message(d.get("message"))
        elif t in ("member.joined", "member.updated"):
            member = d.get("member")
            if isinstance(member, dict) and member.get("userId"):
                self._members[str(member["userId"])] = member
        elif t == "member.left":
            self._members.pop(str(d.get("userId") or ""), None)
        elif t in ("channel.created", "channel.updated"):
            channel = d.get("channel")
            if isinstance(channel, dict) and channel.get("id"):
                if channel.get("type") == "text":
                    self._channels[str(channel["id"])] = channel
                else:
                    self._channels.pop(str(channel["id"]), None)
        elif t == "channel.deleted":
            self._channels.pop(str(d.get("id") or ""), None)
        elif t in ("role.created", "role.updated"):
            role = d.get("role")
            if isinstance(role, dict) and role.get("id"):
                self._roles[str(role["id"])] = str(role.get("name") or "")
        elif t == "role.deleted":
            self._roles.pop(str(d.get("id") or ""), None)
        elif t == "server.updated":
            self._server_name = str(d.get("name") or self._server_name)
            self._owner_id = d.get("ownerId", self._owner_id)

    def _readable(self, text: str) -> str:
        """<@id> → @nickname and <@&role> → @role, so the agent reads names."""
        text = _USER_MENTION.sub(lambda m: "@" + str((self._members.get(m.group(1)) or {}).get("nickname") or m.group(1)), text)
        return _ROLE_MENTION.sub(lambda m: "@" + (self._roles.get(m.group(1)) or m.group(1)), text)

    async def _on_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        author = str(message.get("authorId") or "")
        message_id = message.get("id")
        channel_id = str(message.get("channelId") or "")
        # Own messages and other bots' are never input (no bot loops); nor channels the bot cannot see.
        if not author or author == self._self_id or message.get("authorBot") or message_id is None:
            return
        if channel_id not in self._channels or self._dedup.is_duplicate(str(message_id)):
            return
        text = str(message.get("content") or "")
        mentions = message.get("mentions") or {}
        mentioned = self._self_id in (mentions.get("users") or []) or f"<@{self._self_id}>" in text
        reply = message.get("replyTo") if isinstance(message.get("replyTo"), dict) else None
        replied_to_me = bool(reply and reply.get("authorId") == self._self_id)
        if not self._addressed(channel_id, mentioned or replied_to_me):
            return
        if self._company is not None and not self._company.permits(author, self._owner_id, list((self._members.get(author) or {}).get("roleIds") or []), channel_id, mentioned or replied_to_me):
            return  # the company Hermes: only the panel's access rule
        text = self._readable(text.replace(f"<@{self._self_id}>", " ")).strip()
        for attachment in message.get("attachments") or []:
            if isinstance(attachment, dict):
                text += f"\n[anexo: {attachment.get('name') or 'arquivo'}]"
        text = text.strip()
        if not text:
            return
        channel = self._channels[channel_id]
        member = self._members.get(author) or {}
        source = self.build_source(
            chat_id=channel_id, chat_name=f"{self._server_name} / #{channel.get('name') or channel_id}", chat_type="group",
            user_id=author, user_name=str(member.get("nickname") or author), chat_topic=channel.get("topic") or None,
            guild_id=self._server_id, message_id=str(message_id), role_authorized=self._role_authorized(author))
        reply_author = str(reply.get("authorId") or "") if reply else ""
        await self.handle_message(MessageEvent(
            text=text, message_type=MessageType.COMMAND if text.startswith("/") else MessageType.TEXT,
            source=source, raw_message=message, message_id=str(message_id),
            reply_to_message_id=str(reply["id"]) if reply and reply.get("id") is not None else None,
            reply_to_text=str(reply.get("content") or "") if reply else None,
            reply_to_author_id=reply_author or None,
            reply_to_author_name=str((self._members.get(reply_author) or {}).get("nickname") or "") or None,
            reply_to_is_own_message=replied_to_me,
            channel_prompt=resolve_channel_prompt(self.config.extra, channel_id, None)))

    # --- sending ---

    def _require_client(self) -> GhostLinkBotClient:
        if self._client is None:
            raise GhostLinkError("CONNECTION_LOST", "GhostLink is not connected")
        return self._client

    async def _send_one(self, channel_id: str, text: str, reply_id: Optional[int]) -> SendResult:
        payload: Dict[str, Any] = {"channelId": channel_id, "content": text, "clientMsgId": secrets.token_urlsafe(16)}
        if reply_id is not None:
            payload["replyTo"] = reply_id
        try:
            res = await self._require_client().request("msg.send", payload)
        except GhostLinkError as exc:
            if reply_id is not None and exc.code in ("NOT_FOUND", "BAD_REQUEST"):
                return await self._send_one(channel_id, text, None)  # the replied-to message is gone
            return _failure(exc)
        message = (res or {}).get("message") or {}
        return SendResult(success=True, message_id=str(message["id"]) if message.get("id") is not None else None)

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        if not content:
            return SendResult(success=True)
        channel_id = self._resolve_channel(chat_id)
        if channel_id is None:
            return SendResult(success=False, error=f"GhostLink: no text channel {chat_id!r} the bot can see")
        result = SendResult(success=True)
        reply_id = _message_number(reply_to)
        for index, chunk in enumerate(self.truncate_message(self.format_message(content), MAX_MESSAGE_LENGTH)):
            result = await self._send_one(channel_id, chunk, reply_id if index == 0 else None)
            if not result.success:
                break
        return result

    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False) -> SendResult:
        number = _message_number(message_id)
        if number is None:
            return SendResult(success=False, error=f"GhostLink: bad message id {message_id!r}")
        text = self.format_message(content)
        if len(text) > MAX_MESSAGE_LENGTH:
            text = text[:MAX_MESSAGE_LENGTH - 1] + "…"
        try:
            await self._require_client().request("msg.edit", {"id": number, "content": text})
        except GhostLinkError as exc:
            return _failure(exc)
        return SendResult(success=True, message_id=str(number))

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        channel_id = self._resolve_channel(chat_id)
        now = time.monotonic()
        if channel_id is None or now - self._last_typing.get(channel_id, 0.0) < TYPING_INTERVAL_S:
            return
        self._last_typing[channel_id] = now
        with contextlib.suppress(Exception):
            await self._require_client().request("typing", {"channelId": channel_id}, timeout=5.0)

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        return await self.send(chat_id, f"{caption or ''}\n{image_url}".strip(), reply_to, metadata)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        channel = self._channels.get(self._resolve_channel(chat_id) or "") or {}
        return {"name": f"{self._server_name} / #{channel.get('name') or chat_id}", "type": "group", "chat_id": chat_id}

    def format_message(self, content: str) -> str:
        """GhostLink renders Markdown; an image ![alt](url) becomes its bare link."""
        return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r"\2", content)


# --- config.yaml `ghostlink:` section → env (env wins) ---

_YAML_BRIDGE = (
    ("require_mention", "GHOSTLINK_REQUIRE_MENTION", "lower"),
    ("free_response_channels", "GHOSTLINK_FREE_RESPONSE_CHANNELS", "csv"),
    ("allowed_channels", "GHOSTLINK_ALLOWED_CHANNELS", "csv"),
    ("allowed_roles", "GHOSTLINK_ALLOWED_ROLES", "csv"),
    ("allow_owner", "GHOSTLINK_ALLOW_OWNER", "lower"),
)


def _apply_yaml_config(yaml_cfg: dict, ghostlink_cfg: dict) -> Optional[dict]:
    return _apply_yaml_bridge(ghostlink_cfg, _YAML_BRIDGE)


def register(ctx) -> None:
    """Plugin entry point, called by the Hermes plugin system."""
    ctx.register_platform(
        name=PLATFORM_NAME, label="GhostLink", adapter_factory=GhostLinkAdapter,
        check_fn=check_ghostlink_requirements, validate_config=validate_ghostlink_config,
        is_connected=_env_is_connected("GHOSTLINK_BOT"), required_env=["GHOSTLINK_BOT"],
        install_hint="pip install aiohttp cryptography", apply_yaml_config_fn=_apply_yaml_config,
        allowed_users_env="GHOSTLINK_ALLOWED_USERS", allow_all_env="GHOSTLINK_ALLOW_ALL_USERS",
        cron_deliver_env_var="GHOSTLINK_HOME_CHANNEL", max_message_length=MAX_MESSAGE_LENGTH,
        emoji="👻", platform_hint=PLATFORM_HINT)
