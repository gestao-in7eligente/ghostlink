---
title: Troubleshooting
description: Fixes for the most common GhostLink problems.
---

# Troubleshooting

## Install and open

### Windows won't let me install

That is SmartScreen, because the installer has no paid code signature yet. Click **More info → Run anyway**. To be sure the file is the official one, [verify the download](./verify-downloads).

### "Could not open your identity"

Windows could not decrypt the stored key. This happens, for example, after an administrator resets your Windows password, or when the app folder is copied from another computer. The app **never** creates a new identity by itself in that case. You can:

- **Try again**;
- **Import a backup** (the `.ghostkey` file);
- **Create a new identity**, with a double confirmation. The old file is kept as `identity.bin.bak-<date>`, and you come back to your servers as someone else.

## Invites and connecting

### The invite link opens the browser but not the app

- If the browser asks whether it may open GhostLink, allow it.
- In Firefox, click **Open in GhostLink**.
- If it still does not work, copy the `GL1-…` code the page shows and paste it in the app, under **Join a server**.

### "Invalid invite"

The invite expired, ran out of uses or was revoked. It also happens when the link arrives cut off: copy the whole link. Ask for a new invite.

### "The server key changed"

The server answering at that address is not the same as before. It may be a fake server. Don't continue without confirming with the owner. If the owner reinstalled the server from scratch, they need to send you a new invite.

### Nobody can join my server (hosting in the app)

In this order:

1. **Windows Firewall:** in the host panel, use **Fix firewall**.
2. **UPnP:** if the panel says it could not open the ports, open them by hand on your router: 7700/TCP, 7882/UDP and 7881/TCP to your computer's IP. See [Host in the app](./host-in-app#upnp-opening-ports-automatically).
3. **CGNAT:** if the app warns about CGNAT, nobody outside can reach your computer. Use a VPN (Radmin VPN, Tailscale, ZeroTier) or a [VPS](./host-on-vps).
4. **Test from outside:** open the invite on another computer, or use a phone on mobile data (off your home Wi-Fi).

### "The port is already in use"

Another program is already using port 7700. Accept the next free port the app offers. Old invites stop working: send a new one.

## Voice

### I join the voice room but hear nobody, or nobody hears me

- Check the input and output devices in the voice panel.
- On Windows: **Settings → Privacy & security → Microphone**, turn on **Let desktop apps access your microphone**.
- If you host: Windows must allow **livekit-server.exe** through the firewall (use **Fix firewall**), and port **7882/UDP** must be open. On networks that block UDP, voice uses **7881/TCP**.

### Push-to-talk does not work in a game

If the game runs **as administrator**, Windows does not let other programs read keys while it is in focus. Run the game without administrator rights (or, as a last resort, GhostLink as administrator too).

## Updates

### "Version X failed the signature check"

The app downloaded an update that did not carry the signature of GhostLink's release key. It was deleted and **nothing was installed**. Only download GhostLink from the [site](./download) or the GitHub releases page and, if the warning keeps coming back, [report it](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new).

### The app does not update

Automatic updates only exist in the installed Windows app. Check that **Check for updates automatically** is on under **Updates** in the settings. You can always download the latest version [here](./download) and install it over the old one.

## Error log

The app writes a log to `%APPDATA%\GhostLink\logs\main.log`. It helps explain a problem. Passwords, invites and keys never go into the log, but check its contents before sending it to anyone.
