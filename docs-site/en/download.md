---
title: Download
description: Download GhostLink for Windows.
---

<script setup>
import DownloadButton from '../.vitepress/theme/components/DownloadButton.vue';
</script>

# Download GhostLink

<DownloadButton />

The installer is `GhostLink-Setup-<version>.exe` from the [latest GitHub release](https://github.com/gestao-in7eligente/ghostlink/releases/latest). It installs the app for your user only, without asking for administrator rights.

## Windows warning (SmartScreen)

GhostLink does not have a paid code-signing certificate yet. So, the first time, Windows shows **"Windows protected your PC"**:

1. Click **More info**.
2. Click **Run anyway**.

To be sure the file is the one GitHub Actions built and signed, [verify the download](./verify-downloads) before opening it.

## Requirements

- **Windows 10 or 11, 64-bit.**
- **macOS:** not yet. The Mac app comes in a later version.
- **Linux:** the server only, to [host on a VPS](./host-on-vps).

## Updates

On Windows, the app looks for new versions at startup and every 6 hours, downloads them in the background and shows **"New version X downloaded — Restart to update"**. Before installing, it checks the release's Ed25519 signature: a file without that signature is never installed. You can turn automatic checks off in the settings, under **Updates**.

Every version is on the [releases page](https://github.com/gestao-in7eligente/ghostlink/releases).
