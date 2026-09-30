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

## Updating, restarting and deleting

For now this is done on Railway's dashboard:

- **Update:** in the service, change the version at the end of the image name (for example `:0.2.0` to the new version) and deploy again. The volume keeps the data.
- **Restart:** use "Restart" on the service.
- **Delete:** delete the project. The data goes with it (Railway lets you restore it for 48 hours).

::: warning The address is the one in your invites
Do not delete or recreate the service's TCP proxy: Railway picks another address and the old invites stop working.
:::
