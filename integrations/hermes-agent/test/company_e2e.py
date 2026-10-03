"""Runs the company Hermes's plugin code (client.py + company.py + sites.py) against a GhostLink server for
company-hermes.test.ts, on a scratch HERMES_HOME. Key checks are faked (no network beyond the server), and
there is no Hermes here: the sites get their skill, not the daily job. Prints one JSON line per step; never
prints a key."""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ghostlink"))
from client import GhostLinkBotClient, parse_connection_code  # noqa: E402
from company import PROVIDER_ENV, CompanyAgent, CompanyHome  # noqa: E402
from sites import SitesKeeper  # noqa: E402

# Whether each is in this process's environment, never its value: the five AIs and one of the owner's own.
SHOWN_ENV = [*PROVIDER_ENV.values(), "MINHA_API_KEY"]


def say(**fields):
    print(json.dumps(fields), flush=True)


async def fake_check(provider, key):
    return "ok" if key.startswith("sk-test-ok-") else "refused"


async def main() -> None:
    box = {"welcome": {}, "channels": {}}

    def allowed():
        """Who may talk to it, as the adapter asks for every message (company.permits), among the
        members of the welcome, addressed in the first text channel."""
        welcome = box["welcome"]
        owner = (welcome.get("serverSettings") or {}).get("ownerId")
        channel = next((c["id"] for c in welcome.get("channels") or [] if c.get("type") == "text"), "")
        return sorted(m["userId"] for m in welcome.get("members") or []
                      if box["agent"].permits(m["userId"], owner, list(m.get("roleIds") or []), channel, True))

    def on_welcome(w):
        """As adapter.py: the text channels' names (for the sites' skill) and the server's features (the
        report's key results follow them)."""
        box.update(welcome=w, channels={c["id"]: c.get("name") for c in w.get("channels") or [] if c.get("type") == "text"})
        box["agent"].features = frozenset(str(f) for f in w.get("features") or [])

    async def on_event(t, d):
        channel = d.get("channel") if t in ("channel.created", "channel.updated") else None
        if isinstance(channel, dict) and channel.get("type") == "text":
            box["channels"][channel["id"]] = channel.get("name")
        if await box["agent"].on_event(t, d) and t == "hermes.config":
            say(event=t, version=box["agent"].version, env={v: v in os.environ for v in SHOWN_ENV},
                allowed=allowed(), sites=[s["domain"] for s in box["agent"].sites.sites])

    home = Path(os.environ["HERMES_HOME"])
    client = GhostLinkBotClient(parse_connection_code(os.environ["GHOSTLINK_BOT"]), on_event=on_event, on_welcome=on_welcome)
    box["agent"] = CompanyAgent(CompanyHome(home), request=lambda t, d: client.request(t, d), check_key=fake_check,
                                sites=SitesKeeper(home, cron=None), channel_name=lambda cid: box["channels"].get(cid))
    await client.start()
    say(ready=True)
    await asyncio.Event().wait()  # until the test kills it


asyncio.run(main())
