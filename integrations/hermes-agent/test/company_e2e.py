"""Runs the company Hermes's plugin code (client.py + company.py) against a GhostLink server for
company-hermes.test.ts, on a scratch HERMES_HOME. Key checks are faked (no network beyond the server).
Prints one JSON line per step; never prints a key."""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import GhostLinkBotClient, parse_connection_code  # noqa: E402
from company import PROVIDER_ENV, CompanyAgent, CompanyHome  # noqa: E402


def say(**fields):
    print(json.dumps(fields), flush=True)


async def fake_check(provider, key):
    return "ok" if key.startswith("sk-test-ok-") else "refused"


async def main() -> None:
    box = {"welcome": {}}

    def allowed():
        """Who may talk to it, as the adapter asks for every message (company.permits), among the
        members of the welcome, addressed in the first text channel."""
        welcome = box["welcome"]
        owner = (welcome.get("serverSettings") or {}).get("ownerId")
        channel = next((c["id"] for c in welcome.get("channels") or [] if c.get("type") == "text"), "")
        return sorted(m["userId"] for m in welcome.get("members") or []
                      if box["agent"].permits(m["userId"], owner, list(m.get("roleIds") or []), channel, True))

    async def on_event(t, d):
        if await box["agent"].on_event(t, d) and t == "hermes.config":
            say(event=t, version=box["agent"].version, env={v: v in os.environ for v in PROVIDER_ENV.values()},
                allowed=allowed())

    client = GhostLinkBotClient(parse_connection_code(os.environ["GHOSTLINK_BOT"]), on_event=on_event,
                                on_welcome=lambda w: box.update(welcome=w))
    box["agent"] = CompanyAgent(CompanyHome(Path(os.environ["HERMES_HOME"])), request=lambda t, d: client.request(t, d),
                                check_key=fake_check)
    await client.start()
    say(ready=True)
    await asyncio.Event().wait()  # until the test kills it


asyncio.run(main())
