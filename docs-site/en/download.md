---
title: Download
description: Download GhostLink for Windows and Linux.
---

<script setup>
import DownloadButton from '../.vitepress/theme/components/DownloadButton.vue';
</script>

# Download GhostLink

<DownloadButton />
<DownloadButton os="linux" />

On Windows, the installer is `GhostLink-Setup-<version>.exe` from the [latest GitHub release](https://github.com/gestao-in7eligente/ghostlink/releases/latest). It installs the app for your user only, without asking for administrator rights.

## Windows warning (SmartScreen)

GhostLink does not have a paid code-signing certificate yet. So, the first time, Windows shows **"Windows protected your PC"**:

1. Click **More info**.
2. Click **Run anyway**.

To be sure the file is the one GitHub Actions built and signed, [verify the download](./verify-downloads) before opening it.

## Linux (AppImage)

The file is `GhostLink-<version>-linux-x86_64.AppImage`, from the same release. It runs on any recent x86_64 distribution (Arch, Fedora, Ubuntu…):

```bash
chmod +x GhostLink-*-linux-x86_64.AppImage
./GhostLink-*-linux-x86_64.AppImage
```

- Your identity key is stored encrypted by the system keyring (KWallet, GNOME Keyring or any other Secret Service). Without a keyring, the app cannot create the identity.
- It works on Wayland and X11. Screen sharing on Wayland uses PipeWire and your session's `xdg-desktop-portal`.
- If the AppImage complains about FUSE, install `fuse2` or run it with `--appimage-extract-and-run`.
- There is also a `GhostLink-<version>-linux-x64.tar.gz` for those who prefer not to use an AppImage. It is the base of the AUR `ghostlink-bin` package.

## Requirements

- **Windows 10 or 11, 64-bit.**
- **Linux x86_64** with a recent glibc, a system keyring and, for audio, PipeWire or PulseAudio.
- **macOS:** not yet. The Mac app comes in a later version.
- The server also runs on a [Linux VPS](./host-on-vps).

## Updates

On Windows and in the AppImage, the app looks for new versions at startup and every 6 hours, downloads them in the background and shows **"New version X downloaded — Restart to update"**. Before installing, it checks the release's Ed25519 signatures and that the installer is exactly the one listed for that version: a file without those signatures is never installed, and the app never goes back to an older version. You can turn automatic checks off in the settings, under **Updates**.

Every version is on the [releases page](https://github.com/gestao-in7eligente/ghostlink/releases).
