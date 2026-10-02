---
title: Host on Railway
description: Create, from the app, a GhostLink server that stays online 24 hours on your Railway account.
---

# Host on Railway

[Railway](https://railway.com) is a cloud service. GhostLink creates the server **on your own account**, by itself: no VPS, no router ports to open, no computer left on.

## What you need

- A Railway account. To keep the server online all month, use the **Hobby** plan (US$ 5 a month, with US$ 5 of usage included). The Free and trial plans stop when the credit runs out, and the app warns you before creating.
- GhostLink 0.2.0 or newer.

## Step by step

1. In the app, click the **+** in the left bar and choose **Create a server → In the cloud (Railway)**.
2. Click **Open the tokens page**, sign in to Railway and create a token. Under "Workspace", leave **No workspace** (or pick the workspace where the server will live).
3. Paste the token in the app and click **Connect**.
4. Choose the server name and the region. For Brazil, **US East (Virginia)** usually has the lowest latency.
5. Click **Create server** and follow the steps. The slowest one is "Publishing the server" (1 to 3 minutes). You can close the window: the app keeps going.
6. At the end the app joins the server as its **owner**. Create an invite from the server menu and send it to your group.

If a step fails, the app shows why and two buttons: **Try again** continues from where it stopped, and **Delete what was created** deletes the project on Railway.

## What the app creates on your account

| Item | For |
|---|---|
| A `ghostlink-<name>` project | Keeps the server apart from your other projects. The app touches nothing else on the account. |
| A service with the image `ghcr.io/gestao-in7eligente/ghostlink-server:<version>` | The GhostLink server, at the same version as your app. |
| A volume at `/data` | Holds the server identity (its certificate), the messages and the settings. |
| A TCP proxy | The public address, shaped like `name.proxy.rlwy.net:port`. It is the one in your invites. |

## The token

- The token is stored **encrypted on your computer** and only sent to Railway's API. It never goes to any GhostLink server.
- To make the app forget it, use **Disconnect** on the creation screen. Servers already created keep running.
- To cancel the token for good, delete it on Railway's tokens page.

## Voice on Railway

Railway offers **one TCP port** per service and **no UDP**. So the server runs in **proxy mode**: the same port carries text and voice, and all voice goes over TCP.

- For talking, it works well.
- On connections with packet loss, voice may stutter more than on a server with UDP.
- For camera and screen sharing (in future versions) and for large groups, prefer [hosting in the app](./host-in-app) or [on a VPS](./host-on-vps).

## Limits of proxy mode

Behind the proxy, every connection reaches the server with the proxy's address, not each person's. So:

- the abuse limits apply to the whole server, not per IP;
- banning by IP has no effect. Banning the **person** (by identity) works as usual.

## Costs

The cost goes to your Railway account. A small server uses little memory and CPU and usually fits in the Hobby plan's US$ 5 of usage. Voice uses outbound traffic: a group of 5 people talking 3 hours a day is close to US$ 1 a month.

## Updating

A server the app created follows the version of the **owner's app** (GhostLink 0.2.2 or newer). While the app is open and Railway is connected, it checks the server's version right after updating itself and every 30 minutes. If the server runs an older version, the app switches the service's image to its own version and deploys again:

- **only when nobody is in a voice channel**. If no such moment comes within 24 hours, it updates anyway. People in the chat reconnect by themselves;
- the service's volume and settings stay.

While the server waits, the owner sees at the top of the chat: "This server runs 0.2.0. It will be updated to 0.2.2 when nobody is in a call." **Update now** does not wait: anyone in a call drops for a few seconds. If the Railway token was disconnected, the app asks you to connect it again.

### Docker and servers created by hand

The app only updates the servers it created. On a server in Docker, or one created by hand on Railway, use the image `ghcr.io/gestao-in7eligente/ghostlink-server:latest`: the `latest` tag always points to the newest version (the same signed image as the numbered tag).

- **By hand:** pull the image again and recreate the container (on Railway, deploy the service again). The volume at `/data` keeps the data.
- **By itself, with Watchtower:** it pulls the new image and recreates the container. It does not know whether anyone is in a call, so pick a quiet time. For example, every day at 5 AM, for the `ghostlink` container:

```bash
docker run -d --name watchtower --restart unless-stopped   -v /var/run/docker.sock:/var/run/docker.sock   containrrr/watchtower --schedule "0 0 5 * * *" ghostlink   # checks every day at 5 AM
```

## Ghost DJ and the YouTube block

The image already has ffmpeg: with voice on, the **Ghost DJ** (the music bot, `/play`) works without any setup. YouTube often blocks cloud IPs such as Railway's ("Sign in to confirm you're not a bot"), and `/play` says so when it happens. To fix it, export the YouTube cookies of a logged-in browser in Netscape format (`cookies.txt`), preferably from a separate account, and put the file at `/data/ghost-dj/cookies.txt` (for example through `railway ssh`, pasting the content into `cat > /data/ghost-dj/cookies.txt`). No restart needed.

## Restarting and deleting

On Railway's dashboard:

- **Restart:** use "Restart" on the service.
- **Delete:** delete the project. The data goes with it (Railway lets you restore it for 48 hours).

::: warning The address is the one in your invites
Do not delete or recreate the service's TCP proxy: Railway picks another address and the old invites stop working.
:::
