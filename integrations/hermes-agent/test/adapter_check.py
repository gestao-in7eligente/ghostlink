"""Checks the GhostLink adapter inside a Hermes Agent install (run with Hermes's Python, e.g. in its
container: python adapter_check.py <path to the ghostlink plugin folder>). It loads the plugin the
way Hermes does (a user plugin enabled in a scratch HERMES_HOME), then feeds the adapter a welcome
and messages and records what it would ask the server, with no network. Prints "ok" at the end.
"""

import asyncio
import os
import shutil
import sys
import tempfile

PLUGIN = os.path.abspath(sys.argv[1])
HOME = tempfile.mkdtemp(prefix="ghostlink-check-")
shutil.copytree(PLUGIN, os.path.join(HOME, "plugins", "ghostlink"))
with open(os.path.join(HOME, "config.yaml"), "w") as f:
    f.write("plugins:\n  enabled: [ghostlink]\n")
os.environ.update({
    "HERMES_HOME": HOME,
    "GHOSTLINK_BOT": "ghostlink-bot://ghost.example.com:7700?pin=" + "A" * 43 + "&token=" + "B" * 43,
    "GHOSTLINK_ALLOWED_ROLES": "Admin",
    "GHOSTLINK_FREE_RESPONSE_CHANNELS": "#livre",
})
sys.path.insert(0, os.environ.get("HERMES_SRC", "/opt/hermes"))

from hermes_cli.plugins import discover_plugins  # noqa: E402
from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import platform_registry  # noqa: E402

discover_plugins()
entry = platform_registry.get("ghostlink")
assert entry is not None, "the ghostlink plugin did not register"
assert entry.is_connected(PlatformConfig()), "GHOSTLINK_BOT set: the platform must count as configured"
assert entry.validate_config(PlatformConfig()), "a well-formed code must validate"

ME, OWNER, ADMIN, OTHER = "b" * 32, "0" * 32, "1" * 32, "2" * 32
GERAL, LIVRE, ROLE = "A" * 26, "L" * 26, "C" * 26
adapter = entry.adapter_factory(PlatformConfig(enabled=True))
adapter._apply_welcome({
    "self": {"userId": ME, "nickname": "Hermes"},
    "server": {"serverKeyId": "K" * 43, "name": "TC Flag"},
    "serverSettings": {"ownerId": OWNER},
    "channels": [{"id": GERAL, "name": "geral", "type": "text"}, {"id": LIVRE, "name": "livre", "type": "text"},
                 {"id": "V" * 26, "name": "Voz", "type": "voice"}],
    "roles": [{"id": ROLE, "name": "Admin"}],
    "members": [{"userId": OWNER, "nickname": "Matheus", "roleIds": []}, {"userId": ADMIN, "nickname": "Ana", "roleIds": [ROLE]},
                {"userId": OTHER, "nickname": "Zé", "roleIds": []}, {"userId": ME, "nickname": "Hermes", "roleIds": [], "bot": True}],
})
seen = []


async def capture(event):
    seen.append(event)


adapter.handle_message = capture
next_id = [100]


def msg(author, content, channel=GERAL, **extra):
    next_id[0] += 1
    return {"id": next_id[0], "channelId": channel, "authorId": author, "content": content,
            "mentions": {"users": [ME] if f"<@{ME}>" in content else [], "roles": [], "everyone": False},
            "replyTo": None, "attachments": [], "authorBot": False, **extra}


class Recorder:
    def __init__(self):
        self.calls = []

    async def request(self, t, d=None, timeout=None):
        self.calls.append((t, d))
        return {"message": {"id": 42}} if t in ("msg.send", "msg.edit") else {}


async def main():
    on = adapter._on_message
    await on(msg(OWNER, "sem menção"))
    assert seen == [], "no mention in #geral: ignored"
    await on(msg(OWNER, f"<@{ME}> qual o status? fala com <@{ADMIN}>"))
    assert seen[-1].text == "qual o status? fala com @Ana", seen[-1].text
    assert seen[-1].source.role_authorized is True and seen[-1].source.chat_type == "group"
    assert seen[-1].source.chat_name == "TC Flag / #geral" and seen[-1].source.user_name == "Matheus"
    await on(msg(ADMIN, f"oi <@{ME}>"))
    assert seen[-1].source.role_authorized is True, "a member with the Admin role passes"
    await on(msg(OTHER, f"oi <@{ME}>"))
    assert seen[-1].source.role_authorized is False, "anyone else is left to Hermes's allowlist (default deny)"
    await on(msg(OWNER, "respondendo", replyTo={"id": 7, "authorId": ME, "content": "antes", "deleted": False}))
    assert seen[-1].reply_to_is_own_message is True and seen[-1].reply_to_message_id == "7"
    await on(msg(OWNER, "aqui não precisa", channel=LIVRE))
    assert seen[-1].text == "aqui não precisa", "#livre is a free-response channel"
    await on(msg(OWNER, f"<@{ME}> /new"))
    assert seen[-1].text == "/new" and seen[-1].message_type.name == "COMMAND"
    count = len(seen)
    await on(msg(ME, f"<@{ME}> eu mesmo"))
    await on(msg(ADMIN, f"<@{ME}> de bot", authorBot=True))
    await on(msg(OWNER, f"<@{ME}> canal de voz", channel="V" * 26))
    assert len(seen) == count, "own messages, other bots and non-text channels are ignored"

    rec = Recorder()
    adapter._client = rec
    result = await adapter.send(GERAL, "resposta", reply_to="105")
    assert result.success and result.message_id == "42"
    assert rec.calls[-1][0] == "msg.send" and rec.calls[-1][1]["replyTo"] == 105 and rec.calls[-1][1]["channelId"] == GERAL
    rec.calls.clear()
    result = await adapter.send("#geral", "x" * 9000)
    assert result.success and [t for t, _ in rec.calls] == ["msg.send"] * 3, rec.calls
    assert all(len(d["content"]) <= 4000 for _, d in rec.calls)
    assert not (await adapter.send("inexistente", "oi")).success
    await adapter.edit_message(GERAL, "42", "editado")
    assert rec.calls[-1] == ("msg.edit", {"id": 42, "content": "editado"})
    rec.calls.clear()
    await adapter.send_typing(GERAL)
    await adapter.send_typing(GERAL)
    assert rec.calls == [("typing", {"channelId": GERAL})], "typing at most every 3 s"
    print("ok")


asyncio.run(main())
