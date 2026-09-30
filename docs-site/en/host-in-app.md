---
title: Host in the app
description: Turn your computer into a GhostLink server.
---

# Host in the app

In the app, choose **Host a server**. GhostLink runs the server on your own computer, makes you the owner automatically and gives you an invite ready to send.

## How it works

1. Choose the server name, the port (7700 by default) and how people join. The default is **invite only**.
2. The app creates the server certificate, starts voice, tries to open the ports on your router (UPnP) and checks the firewall.
3. The panel shows the **invite** (copy button), the server **fingerprint**, the addresses and the port status.

The copy button copies the `https://…/ghostlink/j/#GL1-…` link, which works in WhatsApp, Discord and Telegram. Whoever opens it joins straight from the app.

The server keeps running while you chat on another server. Closing the window keeps GhostLink in the Windows **tray**; to stop the server, use **Quit** in the tray menu.

::: tip The server only works while your computer is on
For a server that is always online, create one [on Railway](./host-on-railway) from the app itself, or use a [VPS](./host-on-vps).
:::

## Ports

| Port | Protocol | For |
|---|---|---|
| **7700** | TCP | App connection (text, invites, control) |
| **7882** | UDP | Voice audio |
| **7881** | TCP | Voice fallback, for networks that block UDP |

If port 7700 is already used by another program, the app tells you and offers the next free one (7710, 7720…). Old invites stop working when the port changes.

## UPnP (opening ports automatically)

When hosting, UPnP is always on: the app asks your router to forward the three ports and finds your public IP. When the server stops, the app removes the forwarding.

If your router has no UPnP (or it is off), the app shows how to open the ports by hand:

1. Open your router's page (usually `192.168.0.1` or `192.168.1.1`).
2. Look for **Port forwarding** or **Virtual server**.
3. Forward 7700/TCP, 7882/UDP and 7881/TCP to your computer's local IP address.

## Windows Firewall

The first time, Windows asks whether **GhostLink** and **livekit-server.exe** (voice) may access the network. Tick **private and public networks** and click **Allow access**.

If you declined by mistake, use the **Fix firewall** button in the panel. It creates the right rules and asks for administrator permission once.

## CGNAT: when nobody from outside can join

Some internet providers (mostly fiber and mobile) put many customers behind one public IP. This is called **CGNAT**, and it stops anyone on the internet from reaching your computer, even with the ports open. The app detects it and tells you.

Alternatives:

- **A VPN between you:** everyone installs the same VPN, such as [Radmin VPN](https://www.radmin-vpn.com/), [Tailscale](https://tailscale.com/) or [ZeroTier](https://www.zerotier.com/). The app detects these VPN addresses and puts them in the invite.
- **Ask your provider for a public IP:** some offer one, sometimes for a fee.
- **[Host on a VPS](./host-on-vps).**

## How much bandwidth

In voice, each person sends their audio to the server and receives everyone else's from it. In big rooms, the host's **upload** matters. For large groups, or groups that stay on all day, a VPS is better.

## What the host sees

Whoever hosts has access to everything that goes through the server: messages, audio and the IP of everyone who connects. And everyone with the invite sees the host's IP. Read [Privacy and security](./privacy).

## Moving the server to a VPS

The server's data lives in `%APPDATA%\GhostLink\hosted\<server>\`. Copying that folder into the VPS data folder (`/var/lib/ghostlink`) brings the certificate (and with it the fingerprint), members, roles, channels and messages:

1. Stop the server in the app and install GhostLink on the VPS ([guide](./host-on-vps)).
2. On the VPS, stop the service, replace the contents of `/var/lib/ghostlink` with the copied folder and run `chown -R ghostlink:ghostlink /var/lib/ghostlink`.
3. Start the service again and create new invites: the old ones point to your home address.
