---
title: Privacy and security
description: What GhostLink protects, what it does not, and whom you have to trust.
---

# Privacy and security

This page says plainly what GhostLink protects and what it does **not**.

## What GhostLink protects

- **No account and no central server.** There is no sign-up, email or phone number. Your identity is a key created on your computer and stored encrypted by Windows. The app never sends it to anyone: it only signs a challenge to prove it is you.
- **One identity per server.** Every server gets a different derived key. Two servers cannot tell that you are the same person, and one server cannot impersonate you on another.
- **Encrypted traffic.** Everything between the app and the server goes over TLS, and voice audio is encrypted in transit too.
- **The right server.** The app pins the server's key (the fingerprint in the invite). If someone in the middle tries to pose as the server, the connection is refused. If a saved server's key changes, the app blocks it and warns you.
- **Permissions on the server.** Private channels, roles, kicks and bans are enforced by the server. A private channel never shows up or reaches anyone without access, in any way.
- **Direct messages with no server in between.** Between friends, messages go straight from one computer to the other, end-to-end encrypted. No server stores or reads those conversations.
- **No telemetry.** The server does not talk to third parties. The app does so in two cases only: the update check on GitHub, which you can turn off, and the friends network while "Be available to friends" is on (the default). There, the app uses the public Hyperswarm DHT to find your friends and connects straight to their computers.

## What GhostLink does not protect

::: warning The host sees everything that goes through the server
On servers there is no end-to-end encryption. **Whoever hosts the server can read the messages, hear the audio and see the IP of everyone who connects.** Messages are stored on the server. Only join servers run by people you trust.
:::

- **Hosting exposes your IP** to everyone who has the invite, because the address is inside it. If that bothers you, host on a [VPS](./host-on-vps). Other members do not see each other's IPs: everything goes through the server.
- **Friends see your IP.** The friends network is direct: your friends, and anyone with your friend code while you are online, see your IP. The public DHT nodes that hold your announcement see your friend key and your IP, but not the messages. To leave the network, turn "Be available to friends" off (in Friends → Add friend). To cut off anyone holding an old code, make a new code.
- **Invites grant access.** Anyone with a valid invite link can join the server. Only send invites to people who should join, prefer invites with a use limit and an expiry, and revoke invites that leak.
- **Automatic updates trust GitHub, the CI and the release key.** The app only installs a version signed with GhostLink's release key, which lives in a protected GitHub environment and is only used after manual approval. If that key, the project account or GitHub were compromised, a malicious version could get through. To avoid depending on that, turn automatic updates off and [verify every download](./verify-downloads).
- **Message numbers reveal the volume.** Every message ID is increasing and unique across the whole server. From the gaps between IDs, any member can estimate how many messages were sent in total, including in channels they cannot see. The content and the channel of those messages stay hidden.
- **Your computer.** Anyone who uses your Windows account can open GhostLink as you. The `.ghostkey` backup is as sensitive as the identity itself: protect it with a strong password.

## This site

The site uses no cookies, trackers or third-party fonts or scripts. The download buttons ask the GitHub API for the latest version from your browser. On the invite page (`/j/`), the invite sits after the `#` of the link: that part **is never sent** to any server, not even this site. The page only reads the invite in your browser and hands it to the app.

## Reporting a security issue

Don't open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new).
