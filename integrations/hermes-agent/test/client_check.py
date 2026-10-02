"""Drives ghostlink/client.py against a GhostLink server for ghostlink-client.test.ts, printing one
JSON line per step on stdout.

GHOSTLINK_BOT  the connection code
GL_MODE        'chat' (default): wait for a message that mentions the bot, then typing, a reply,
               an edit, and a request the server refuses; 'wrong-pin': expect PIN_MISMATCH.
"""

import asyncio
import dataclasses
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import GhostLinkBotClient, GhostLinkError, parse_connection_code  # noqa: E402


def say(**fields):
    print(json.dumps(fields), flush=True)


async def main() -> None:
    code = parse_connection_code(os.environ["GHOSTLINK_BOT"])
    if os.environ.get("GL_MODE") == "wrong-pin":
        code = dataclasses.replace(code, pin="A" * 43)
    inbox: asyncio.Queue = asyncio.Queue()

    async def on_event(t, d):
        if t == "msg.new":
            await inbox.put(d.get("message") or {})

    client = GhostLinkBotClient(code, on_event=on_event, on_welcome=lambda w: None)
    try:
        welcome = await client.start()
    except GhostLinkError as exc:
        say(error=exc.code)
        return
    me = welcome["self"]["userId"]
    say(ready=me, channels=[c["name"] for c in welcome.get("channels", []) if c.get("type") == "text"],
        owner=(welcome.get("serverSettings") or {}).get("ownerId"))
    while True:
        message = await asyncio.wait_for(inbox.get(), 15)
        if message.get("authorId") != me and me in (message.get("mentions") or {}).get("users", []):
            break
    await client.request("typing", {"channelId": message["channelId"]})
    sent = await client.request("msg.send", {"channelId": message["channelId"], "content": "pong",
                                             "clientMsgId": "hermes-check-1", "replyTo": message["id"]})
    say(sent=sent["message"]["id"], replyTo=(sent["message"].get("replyTo") or {}).get("id"))
    edited = await client.request("msg.edit", {"id": sent["message"]["id"], "content": "pong (edited)"})
    say(edited=edited["message"]["content"])
    try:
        await client.request("msg.edit", {"id": 999_999, "content": "x"})
    except GhostLinkError as exc:
        say(refused=exc.code)
    await client.close()
    say(done=True)


asyncio.run(main())
