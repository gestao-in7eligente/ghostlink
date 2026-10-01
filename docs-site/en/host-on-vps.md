---
title: Host on a VPS
description: Install the GhostLink server on a Linux VPS with install.sh.
---

# Host on a VPS

On a VPS, the server is online all the time, with a fixed IP, without depending on your computer or your router.

## Requirements

- **Ubuntu 22.04 or newer**, or **Debian 12 or newer**, on x64 or arm64.
- **root** access (or `sudo`).
- A public IP.
- In your provider's panel (cloud firewall), allow **7700/TCP**, **7882/UDP** and **7881/TCP**. The script opens the same ports in `ufw` if it is active.

For a few people, the smallest VPS is usually enough. All voice goes through the server, so check the bandwidth included in the plan.

## Install

Download `install.sh` from the latest release and, ideally, verify it before running it. Save the release public key as `ghostlink-release.pem` first (it is on [Verify downloads](./verify-downloads)):

```bash
BASE=https://github.com/gestao-in7eligente/ghostlink/releases/latest/download
curl -fsSLO "$BASE/install.sh"
curl -fsSLO "$BASE/checksums-sha256.txt"
curl -fsSLO "$BASE/checksums-sha256.txt.ed25519"
openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin \
  -in checksums-sha256.txt -sigfile checksums-sha256.txt.ed25519   # must print "Signature Verified Successfully"
sha256sum --ignore-missing -c checksums-sha256.txt                  # must print "install.sh: OK"
sudo bash install.sh
```

The script:

1. installs Node.js 24 (NodeSource);
2. creates the `ghostlink` system user;
3. downloads `ghostlink-server-<version>.tgz` from the latest release and checks its **checksum** and the **release Ed25519 signature** (and the Sigstore bundle, if `cosign` is installed);
4. installs it in `/opt/ghostlink` and downloads the voice server (LiveKit), checking its SHA-256; data lives in `/var/lib/ghostlink`;
5. finds the public IP from the default route, without sending any packet. If the VPS only has a private IP (behind the provider's NAT), it asks for the public IP, or you pass `--node-ip`:
   ```bash
   sudo bash install.sh --node-ip 203.0.113.10
   ```
6. creates a `systemd` service that restarts by itself, with a protected file system and no access to home folders;
7. opens the ports in `ufw`, if active;
8. installs the **automatic update** (see [Update](#update));
9. prints the **setup code**, the **fingerprint** and an **invite**.

## Become the owner

The setup code makes whoever uses it first the server **owner**. Join the server from the app with the invite and give the setup code when connecting. It works once and is deleted after use.

Keep the fingerprint: anyone who joins without an invite, with just the address, should check that it matches what the app shows.

## Useful commands

The server runs as the `ghostlink` user. To create another invite (here with 10 uses and a 7-day expiry):

```bash
sudo -u ghostlink node /opt/ghostlink/current/dist/cli.js invite --data /var/lib/ghostlink --max-uses 10 --expires 7d
```

| Command | For |
|---|---|
| `invite [--max-uses N] [--expires 24h\|7d]` | Creates an invite (while the server runs) |
| `status` | Version, fingerprint and member summary |
| `setup-code` | Shows the setup code, if there is no owner yet |
| `reset-owner` | Recovers ownership: creates a new setup code |
| `version` | Server version |

Invites can also be created and revoked in the app, under **Server settings → Invites**, by anyone allowed to.

## Update

The server follows the app's version by itself. Every hour, `ghostlink-update.timer` looks for a new release. When there is one, it:

1. downloads and checks the new version the same way the installation does (signed checksums and the release Ed25519 signature) and gets it ready in `/opt/ghostlink/releases/<version>`, without touching the one running;
2. switches versions and restarts the server **only when nobody is in a voice channel**. If no such moment comes within **24 hours**, it switches anyway: anyone in a call drops for a few seconds. People in the chat reconnect by themselves.

LiveKit is updated too when the new version asks for another one. The data stays.

To see when it runs and what it did:

```bash
systemctl list-timers ghostlink-update.timer
journalctl -u ghostlink-update -n 50
```

To look for a new version now (the switch still waits for nobody to be in a call):

```bash
sudo bash /opt/ghostlink/install.sh --auto-update
```

To turn the automatic update off, and back on:

```bash
sudo bash /opt/ghostlink/install.sh --auto-update off
sudo bash /opt/ghostlink/install.sh --auto-update on
```

To install without it from the start, use `sudo bash install.sh --no-auto-update`. The choice is kept: running `install.sh` again does not change it.

Without the automatic update, update by hand: run the latest release's `install.sh` again. It is idempotent: it updates the server and keeps the data.

A server in Docker, or one created by hand on Railway? See [Docker and servers created by hand](./host-on-railway#docker-and-servers-created-by-hand).

::: tip Servers installed before 0.2.2
The automatic update arrived in 0.2.2. On an older server, run the latest release's `install.sh` once, as in the installation. From then on it updates itself.
:::

## Coming from the app

You can move a server you hosted in the app to the VPS, with the same people and the same fingerprint. See [Moving the server to a VPS](./host-in-app#moving-the-server-to-a-vps).
