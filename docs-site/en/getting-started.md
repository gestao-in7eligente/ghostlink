---
title: Getting started
description: Install GhostLink, create your identity and join a server.
---

# Getting started

## 1. Install the app

[Download the Windows installer](./download) and open it. The first time, SmartScreen may warn you: click **More info → Run anyway**.

## 2. Your identity

GhostLink **has no accounts**. The first time it opens, the app creates a cryptographic key that stays on your computer only, encrypted by Windows. That key proves who you are on each server. Every server gets a different derived key, so two servers cannot tell that you are the same person.

Then you choose a language and a nickname. You can change the nickname on each server.

::: warning Make a backup
Without a backup, **losing your computer means losing your identity**: you come back to your servers as someone else, without your roles. Export your identity (the app offers it the first time it opens and in the settings): that creates a `.ghostkey` file protected by a password you choose. Keep the file and the password in different places. To use the same identity on another computer, import the file.
:::

## 3. Join a server

Whoever hosts a server (or one of its admins) sends you an **invite**. There are three ways to use it:

- **Invite link** (`https://gestao-in7eligente.github.io/ghostlink/j/#GL1-…`): open it in your browser. The page opens GhostLink straight into the invite. If you don't have the app yet, it shows the download and a code to paste later.
- **`GL1-…` code**: in the app, choose **Join a server** and paste it.
- **`host:port` address**, without an invite: only works on open or password servers. The app shows the server's **fingerprint** (four groups of eight characters). Ask the owner for the fingerprint through another channel and compare before you continue: that is what guarantees you are talking to the right server.

With an invite, the fingerprint comes along and the app checks it by itself.

::: danger If the app says the server key changed
Don't continue without talking to the owner. It may be a fake server in place of the real one.
:::

The left bar keeps the servers you have joined. The app stays connected to one server at a time.

## 4. Chat

- **Text:** type in the channel and press **Enter** (Shift+Enter adds a new line). You can reply, react, edit and delete your messages, and mention someone with `@`. Messages accept light markdown, such as `**bold**` and code blocks.
- **Voice:** click a voice room to join. In the bottom panel you mute your microphone, deafen and pick your input and output devices. You can set each person's volume and use push-to-talk, even with another program (a game) in focus.

What each person can do depends on the **roles** the server gives them. The server enforces all of it; it is not just hidden on screen.

## 5. Host your own

Anyone can create a server. See [Host in the app](./host-in-app) (easiest) or [Host on a VPS](./host-on-vps) (always online).
