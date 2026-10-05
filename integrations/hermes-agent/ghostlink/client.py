"""GhostLink bot client for Python (bots spec 2026-10-02 §1, §2), used by the Hermes Agent plugin.

Mirrors packages/discord-compat/src/gateway.ts and pinning.ts, without Hermes imports so it can be
checked on its own (../test/client_check.py):

- the connection code ``ghostlink-bot://<host:port>?pin=<serverKeyId>&token=<secret>``;
- TLS pinned to the server's key, serverKeyId = base64url(SHA-256(SPKI DER)). A first handshake reads
  the certificate and checks its key against the pin; the WebSocket then accepts only that exact
  certificate (aiohttp.Fingerprint), so the token never reaches a server with another key;
- the bot hello (no challenge), requests ``{t, id, d}`` answered by ``res``, the server's events, and
  reconnecting with backoff (1 to 30 s, ±20 % jitter). Codes no retry can fix stop for good.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import ipaddress
import json
import logging
import random
import re
import ssl
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Tuple
from urllib.parse import parse_qs

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
CLIENT_NAME = "hermes-ghostlink/1.1"
DEFAULT_PORT = 7700
MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024

_SCHEME = "ghostlink-bot://"
_B64U_32 = re.compile(r"^[A-Za-z0-9_-]{43}$")
_HOSTNAME = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")

# Retrying cannot help: someone must act (copy a new code, update the server, unban the bot).
FATAL_CODES = frozenset({
    "PIN_MISMATCH", "BAD_BOT_TOKEN", "PROTOCOL_UNSUPPORTED", "BAD_REQUEST", "BANNED", "KICKED",
    "REJOIN_BLOCKED", "SERVER_DELETING", "SERVER_DELETED",
})

# Retrying soon cannot help, but it may later: these codes wait longer between attempts.
SLOW_RETRY: Dict[str, float] = {
}

_EXPLAIN = {
    "PIN_MISMATCH": "the server's TLS key does not match the pin in the connection code; nothing was sent. Copy the code again from the app",
    "BAD_BOT_TOKEN": "the server does not know this connection code: a new code was generated or the bot was deleted. Create a new code in the app (BOTS)",
    "PROTOCOL_UNSUPPORTED": "the server speaks another protocol version: bots need a GhostLink 0.4.0 server or newer",
    "BAD_REQUEST": "the server refused the bot's hello: bots need a GhostLink 0.4.0 server or newer",
    "BANNED": "the bot is banned from this server",
    "KICKED": "the bot was kicked from this server",
    "REJOIN_BLOCKED": "the bot was kicked from this server and cannot come back yet",
    "SERVER_DELETING": "the server is being deleted",
    "SERVER_DELETED": "the server was deleted",
    "RATE_LIMITED": "too many failed attempts from this address; wait a minute",
}


class GhostLinkError(Exception):
    """A protocol failure with the server's error code (e.g. BAD_BOT_TOKEN, RATE_LIMITED)."""

    def __init__(self, code: str, message: str = "", request: Optional[str] = None):
        self.code = code
        self.request = request
        super().__init__(f"{code}: {message or _EXPLAIN.get(code, code)}")


@dataclass(frozen=True)
class ConnectionCode:
    host: str
    port: int
    pin: str
    token: str = field(repr=False)  # the bot's secret: never logged

    @property
    def address(self) -> str:
        return f"[{self.host}]:{self.port}" if ":" in self.host else f"{self.host}:{self.port}"


def _parse_host_port(s: str) -> Tuple[str, int]:
    """packages/shared/src/invite.ts parseHostPort: IPv6 in brackets, default port 7700."""
    if not s or len(s) > 262:
        raise ValueError("invalid address")
    port_text: Optional[str] = None
    if s.startswith("["):
        end = s.find("]")
        if end < 0:
            raise ValueError("invalid address")
        host = str(ipaddress.IPv6Address(s[1:end]))
        rest = s[end + 1:]
        if rest.startswith(":"):
            port_text = rest[1:]
        elif rest:
            raise ValueError("invalid address")
    else:
        parts = s.split(":")
        if len(parts) > 2:
            raise ValueError("IPv6 addresses must be written in brackets")
        host = parts[0].lower()
        port_text = parts[1] if len(parts) == 2 else None
        if re.fullmatch(r"[0-9.]+", host):
            ipaddress.IPv4Address(host)
        elif not _HOSTNAME.match(host):
            raise ValueError("invalid host")
    port = DEFAULT_PORT
    if port_text is not None:
        if not re.fullmatch(r"[0-9]{1,5}", port_text) or not 1 <= int(port_text) <= 65535:
            raise ValueError("invalid port")
        port = int(port_text)
    return host, port


def parse_connection_code(value: Any) -> ConnectionCode:
    """The code the app shows once when a bot is created. Surrounding spaces and quotes (as pasted in
    a .env file) are fine. Raises ValueError without echoing the input: it holds the bot's secret."""
    error = ValueError("not a GhostLink bot connection code (ghostlink-bot://host:port?pin=…&token=…)")
    if not isinstance(value, str) or len(value) > 1024:
        raise error
    s = value.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        s = s[1:-1].strip()
    if not s.lower().startswith(_SCHEME):
        raise error
    authority, sep, query = s[len(_SCHEME):].partition("?")
    if not sep:
        raise error
    params = parse_qs(query, keep_blank_values=True)
    pin = (params.get("pin") or [""])[0]
    token = (params.get("token") or [""])[0]
    if not _B64U_32.match(pin) or not _B64U_32.match(token):
        raise error
    try:
        host, port = _parse_host_port(authority[:-1] if authority.endswith("/") else authority)
    except ValueError:
        raise error from None
    return ConnectionCode(host=host, port=port, pin=pin, token=token)


def server_key_id(certificate_der: bytes) -> str:
    """base64url(SHA-256(SPKI DER)): never the raw key nor the whole certificate's hash (spec §3.2)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    spki = x509.load_der_x509_certificate(certificate_der).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.urlsafe_b64encode(hashlib.sha256(spki).digest()).rstrip(b"=").decode("ascii")


async def _peer_certificate(host: str, port: int, timeout: float) -> bytes:
    """One TLS handshake without CA validation, only to read the server's certificate."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    _reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port, ssl=ctx, server_hostname=host), timeout)
    try:
        ssl_object = writer.get_extra_info("ssl_object")
        der = ssl_object.getpeercert(binary_form=True) if ssl_object is not None else None
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.wait_closed(), 2)
    if not der:
        raise GhostLinkError("UNREACHABLE", "the server sent no certificate")
    return der


@dataclass
class Timing:
    attempt_timeout: float = 10.0  # TCP + TLS + WebSocket upgrade
    handshake_timeout: float = 20.0  # from the upgrade to `welcome`
    request_timeout: float = 15.0
    heartbeat: float = 20.0  # our pings; the server also pings every 15 s
    backoff_min: float = 1.0
    backoff_max: float = 30.0
    stable_session: float = 30.0  # a session that lasted this long resets the backoff


def backoff_delay(attempt: int, timing: Timing, rand: Callable[[], float] = random.random) -> float:
    base = min(timing.backoff_max, timing.backoff_min * 2 ** min(attempt, 30))
    return min(timing.backoff_max, max(timing.backoff_min, base * (0.8 + 0.4 * rand())))


def reconnect_delay(cause: str, attempt: int, timing: Timing, rand: Callable[[], float] = random.random) -> float:
    """The backoff, or longer for codes only time fixes (SLOW_RETRY)."""
    return max(backoff_delay(attempt, timing, rand), SLOW_RETRY.get(cause, 0.0))


EventHandler = Callable[[str, Dict[str, Any]], Awaitable[None]]
WelcomeHandler = Callable[[Dict[str, Any]], None]
FatalHandler = Callable[[GhostLinkError], Awaitable[None]]
RefusedHandler = Callable[[str], Awaitable[None]]


class GhostLinkBotClient:
    """One bot session: ``await start()`` connects once (raising GhostLinkError on failure), then a
    background task keeps the session and reconnects. ``on_welcome`` runs on every (re)connection,
    ``on_event`` for each server event, ``on_fatal`` when the session stops for good, ``on_refused`` with
    the code each time the server refuses a hello or ends the session with one (BAD_BOT_TOKEN…; never a plain network loss). on_refused runs as its own task: it never delays nor
    changes connecting or reconnecting."""

    def __init__(self, code: ConnectionCode, *, on_event: EventHandler, on_welcome: WelcomeHandler,
                 on_fatal: Optional[FatalHandler] = None, timing: Optional[Timing] = None,
                 on_refused: Optional[RefusedHandler] = None):
        self._code = code
        self._on_event = on_event
        self._on_welcome = on_welcome
        self._on_fatal = on_fatal
        self._on_refused = on_refused
        self._notices: Set[asyncio.Task] = set()  # on_refused tasks still running
        self._timing = timing or Timing()
        self._session: Any = None  # aiohttp.ClientSession
        self._ws: Any = None  # aiohttp.ClientWebSocketResponse
        self._task: Optional[asyncio.Task] = None
        self._consumer: Optional[asyncio.Task] = None
        self._events: asyncio.Queue = asyncio.Queue()
        self._closing = False
        self._next_id = 0
        self._pending: Dict[int, Tuple[str, asyncio.Future]] = {}
        self._close_reason: Optional[str] = None
        self.state = "idle"  # idle | connected | reconnecting | closed

    @property
    def connected(self) -> bool:
        return self.state == "connected" and self._ws is not None and not self._ws.closed

    async def start(self) -> Dict[str, Any]:
        import aiohttp

        if self.state != "idle":
            raise GhostLinkError("BAD_REQUEST", "this client was already started")
        self._session = aiohttp.ClientSession()
        try:
            ws, welcome = await self._establish()
        except BaseException:
            await self.close()
            raise
        self._attach(ws, welcome)
        self._consumer = asyncio.create_task(self._consume(), name="ghostlink-events")
        self._task = asyncio.create_task(self._run(ws), name="ghostlink-session")
        return welcome

    async def request(self, t: str, d: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        """A request after the welcome; the server's error response raises GhostLinkError."""
        ws = self._ws
        if not self.connected or ws is None:
            raise GhostLinkError("CONNECTION_LOST", "the bot is not connected to the server", t)
        self._next_id += 1
        rid = self._next_id
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = (t, future)
        try:
            await ws.send_str(json.dumps({"t": t, "id": rid, "d": d or {}}))
            return await asyncio.wait_for(future, timeout or self._timing.request_timeout)
        except asyncio.TimeoutError:
            raise GhostLinkError("TIMEOUT", f"no answer to {t}", t) from None
        except ConnectionError as exc:
            raise GhostLinkError("CONNECTION_LOST", str(exc), t) from None
        finally:
            self._pending.pop(rid, None)

    async def close(self) -> None:
        """Stops everything, reconnecting included."""
        self._closing = True
        for name in ("_task", "_consumer"):
            task = getattr(self, name)
            setattr(self, name, None)
            if task is not None and task is not asyncio.current_task():
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        self._fail_pending("the client closed")
        if self._session is not None:
            with contextlib.suppress(Exception):
                await self._session.close()
            self._session = None
        self.state = "closed"

    # ---- connecting ----

    async def _establish(self) -> Tuple[Any, Dict[str, Any]]:
        """TLS pin check, then the WebSocket pinned to that certificate, then hello → welcome."""
        import aiohttp

        code = self._code
        try:
            der = await _peer_certificate(code.host, code.port, self._timing.attempt_timeout)
        except GhostLinkError:
            raise
        except (OSError, asyncio.TimeoutError, ssl.SSLError) as exc:
            raise GhostLinkError("UNREACHABLE", f"{code.address}: {exc or type(exc).__name__}") from None
        if server_key_id(der) != code.pin:
            raise GhostLinkError("PIN_MISMATCH")
        try:
            ws = await asyncio.wait_for(self._session.ws_connect(
                f"wss://{code.address}/ws",
                ssl=aiohttp.Fingerprint(hashlib.sha256(der).digest()),
                heartbeat=self._timing.heartbeat,
                autoping=True,
                max_msg_size=MAX_INBOUND_FRAME_BYTES,
                compress=0,
            ), self._timing.attempt_timeout)
        except aiohttp.ServerFingerprintMismatch:
            # The certificate changed between the two handshakes (a restart); the next try re-reads it.
            raise GhostLinkError("UNREACHABLE", f"{code.address}: the certificate changed while connecting") from None
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as exc:
            raise GhostLinkError("UNREACHABLE", f"{code.address}: {exc or type(exc).__name__}") from None
        try:
            welcome = await asyncio.wait_for(self._handshake(ws), self._timing.handshake_timeout)
        except asyncio.TimeoutError:
            await ws.close()
            raise GhostLinkError("TIMEOUT", "no welcome from the server") from None
        except BaseException:
            await ws.close()
            raise
        return ws, welcome

    async def _handshake(self, ws: Any) -> Dict[str, Any]:
        """Bot hello → welcome | error (no challenge for a bot, bots spec §2)."""
        import aiohttp

        client = f"{CLIENT_NAME} (python {sys.version_info[0]}.{sys.version_info[1]})"
        await ws.send_str(json.dumps({"t": "hello", "d": {"protocol": PROTOCOL_VERSION, "bot": self._code.token, "client": client[:128]}}))
        while True:
            msg = await ws.receive()
            if msg.type == aiohttp.WSMsgType.TEXT:
                break
            if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                code = self._server_code(ws, msg)
                self._refused(code)
                raise GhostLinkError(code or "CONNECTION_LOST")
        try:
            frame = json.loads(msg.data)
        except (TypeError, ValueError):
            raise GhostLinkError("INTERNAL", "the server sent an invalid frame") from None
        t = frame.get("t") if isinstance(frame, dict) else None
        d = frame.get("d") if isinstance(frame, dict) else None
        if t == "error":
            code = str((d or {}).get("code") or "INTERNAL")
            self._refused(code)
            raise GhostLinkError(code)
        if t == "welcome" and isinstance(d, dict) and isinstance(d.get("self"), dict):
            return d
        # A challenge means a server without bots (before 0.4.0) took the hello for a person's.
        raise GhostLinkError("BAD_REQUEST")

    # ---- the session ----

    def _attach(self, ws: Any, welcome: Dict[str, Any]) -> None:
        """The session is live: requests may go out, and the welcome refreshes the caller's view."""
        self._ws, self._close_reason, self.state = ws, None, "connected"
        try:
            self._on_welcome(welcome)
        except Exception:  # a bug there must not end the bot
            logger.exception("GhostLink: error applying the welcome")

    async def _run(self, ws: Any) -> None:
        failures = 0
        while not self._closing:
            started = time.monotonic()
            cause = "CONNECTION_LOST"
            try:
                cause = await self._listen(ws)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("GhostLink: session error")
            finally:
                self._ws = None
                self._fail_pending("the connection closed before the answer")
                with contextlib.suppress(Exception):
                    await ws.close()
            if self._closing:
                return
            if time.monotonic() - started >= self._timing.stable_session:
                failures = 0
            while True:  # reconnect until it works or a code says stop
                if cause in FATAL_CODES:
                    return await self._stop(GhostLinkError(cause))
                if cause == "SESSION_REPLACED":
                    logger.warning("GhostLink: another process connected with this bot's connection code and took its session; reconnecting")
                delay = reconnect_delay(cause, failures, self._timing)
                failures += 1
                self.state = "reconnecting"
                logger.info("GhostLink: connection lost (%s); reconnecting in %.1f s", cause, delay)
                await asyncio.sleep(delay)
                try:
                    ws, welcome = await self._establish()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # keep trying whatever broke, until a code says stop
                    cause = exc.code if isinstance(exc, GhostLinkError) else "UNREACHABLE"
                    if cause not in FATAL_CODES:
                        logger.info("GhostLink: reconnect failed: %s", exc)
                    continue
                self._attach(ws, welcome)
                logger.info("GhostLink: reconnected")
                break

    async def _listen(self, ws: Any) -> str:
        """Frames until the socket closes; returns why it closed (an error code). Not `async for`:
        aiohttp's iterator swallows the close frame, and with it the server's reason."""
        import aiohttp

        while True:
            msg = await ws.receive()
            if msg.type == aiohttp.WSMsgType.TEXT:
                self._on_frame(msg.data)
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                code = self._close_reason or self._server_code(ws, msg)
                self._refused(code)
                return code or "CONNECTION_LOST"

    async def _consume(self) -> None:
        """Server events, in order, apart from the reader: a handler may await a request without
        blocking the frame that answers it (nor the pings)."""
        while True:
            t, d = await self._events.get()
            try:
                await self._on_event(t, d)
            except Exception:
                logger.exception("GhostLink: error handling %s", t)

    def _on_frame(self, data: str) -> None:
        try:
            frame = json.loads(data)
        except (TypeError, ValueError):
            return  # clients ignore malformed frames
        if not isinstance(frame, dict) or not isinstance(frame.get("t"), str):
            return
        t = frame["t"]
        if t == "res":
            pending = self._pending.get(frame.get("id")) if isinstance(frame.get("id"), int) else None
            if pending is None or pending[1].done():
                return
            name, future = pending
            if frame.get("ok") is True:
                future.set_result(frame.get("d"))
            else:
                error = frame.get("error") if isinstance(frame.get("error"), dict) else {}
                future.set_exception(GhostLinkError(str(error.get("code") or "INTERNAL"), str(error.get("message") or ""), name))
            return
        if t == "error":
            # Sent right before the server closes (BAD_BOT_TOKEN after a new code, SESSION_REPLACED…).
            d = frame.get("d") if isinstance(frame.get("d"), dict) else {}
            self._close_reason = str(d.get("code") or "INTERNAL")
            return
        self._events.put_nowait((t, frame.get("d") if isinstance(frame.get("d"), dict) else {}))

    @staticmethod
    def _server_code(ws: Any, msg: Any) -> Optional[str]:
        """Close code 4000 carries the server's error code as its reason; any other close has none."""
        reason = getattr(msg, "extra", None)
        data = getattr(msg, "data", None)
        code = data if isinstance(data, int) else getattr(ws, "close_code", None)
        if code == 4000 and isinstance(reason, str) and _ERROR_CODE.match(reason):
            return reason
        return None

    def _refused(self, code: Optional[str]) -> None:
        """The server's own code for a refused hello or an ended session, to on_refused, as its own task."""
        if code is None or self._on_refused is None:
            return
        task = asyncio.ensure_future(self._tell_refused(self._on_refused, code))
        self._notices.add(task)
        task.add_done_callback(self._notices.discard)

    @staticmethod
    async def _tell_refused(handler: RefusedHandler, code: str) -> None:
        try:
            await handler(code)
        except Exception:  # a bug there must not end the bot
            logger.exception("GhostLink: error handling the refusal %s", code)

    def _fail_pending(self, why: str) -> None:
        for rid, (name, future) in list(self._pending.items()):
            if not future.done():
                future.set_exception(GhostLinkError("CONNECTION_LOST", why, name))
            self._pending.pop(rid, None)

    async def _stop(self, error: GhostLinkError) -> None:
        self.state = "closed"
        logger.error("GhostLink: stopped: %s", error)
        if self._on_fatal is not None:
            with contextlib.suppress(Exception):
                await self._on_fatal(error)
