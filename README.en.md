<p align="center"><img src="docs-site/public/logo.svg" width="96" height="96" alt=""></p>

<h1 align="center">GhostLink</h1>

<p align="center">
  Discord-style text and voice chat on your own server, with no account.<br>
  <a href="https://gestao-in7eligente.github.io/ghostlink/en/download"><b>Download for Windows</b></a> ·
  <a href="https://gestao-in7eligente.github.io/ghostlink/en/">Website</a> ·
  <a href="README.md">Português</a>
</p>

GhostLink is a free and open-source desktop app for text and voice chat. **Anyone can host their own server**: on their own computer, in the cloud (the app creates the server on your Railway account) or on a Linux VPS. There is no account and no central server: your identity is a key that stays on your computer, and every server gets a different derived key.

> **Beta (0.x).** Windows-only for now. Friends and direct messages, camera, screen sharing, files and the macOS app come in the next versions.

## In 0.2

- **Text:** channels, history, replies, editing, reactions, mentions, unread counts, safe markdown and notifications.
- **Voice** (LiveKit): mute, deafen, speaking indicator, devices, per-person volume and push-to-talk (global on Windows).
- **Roles and moderation:** permissions enforced by the server, private channels, invites with limits and expiry, kick, ban, ownership transfer and recovery.
- **Hosting:** in the app, with UPnP, CGNAT detection and a firewall fix; in the cloud, with a server the app creates on your Railway account; or on a VPS with `install.sh`.
- **Security:** TLS with the server certificate pinned, identity on the device only, `.ghostkey` backup, no telemetry, automatic updates checked with Ed25519.

Read [Privacy and security](https://gestao-in7eligente.github.io/ghostlink/en/privacy) before using it: **whoever hosts a server sees what goes through it** (there is no end-to-end encryption).

## Screenshots

_Coming soon._

## Download and verify

The installer (`GhostLink-Setup-<version>.exe`) is on the [releases page](https://github.com/gestao-in7eligente/ghostlink/releases/latest). It has no paid code signature yet, so SmartScreen warns the first time: **More info → Run anyway**.

Every release ships `checksums-sha256.txt`, signed with Sigstore (cosign keyless) and with the Ed25519 release key, plus a `.ed25519` signature for every file. See [Verify downloads](https://gestao-in7eligente.github.io/ghostlink/en/verify-downloads).

## Development

Requirements: Node.js 24.14 or newer. The desktop app runs and is packaged on Windows and macOS; the server and the tests also run on Linux.

```bash
npm install          # installs every workspace
npm test             # unit and integration tests (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript in every package, in scripts/ and in the site
npm run build        # typecheck + server (apps/server/dist/cli.js) + app (apps/desktop/out)
npm run dev          # opens the app in development mode (electron-vite)
npm run smoke:dev    # opens the built app with GHOSTLINK_SMOKE=1 and checks it starts and quits by itself
npm run docs:dev     # site (VitePress) at http://localhost:5173/ghostlink/
npm run docs:build   # builds the site into docs-site/.vitepress/dist
```

Run a local server: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

The Electron binary is downloaded the first time it is used (or with `node node_modules/electron/install.js`). In the VS Code terminal, `ELECTRON_RUN_AS_NODE=1` turns Electron into plain Node, so every command that opens the app goes through `scripts/run-electron.mjs` (or, for the packaged app, `npm run smoke`), which removes it. The packaged app ignores the variable anyway (`runAsNode` fuse off).

Layout: `packages/shared` (protocol and shared rules), `apps/server` (server + `ghostlink-server` CLI), `apps/desktop` (Electron app: `src/main`, `src/preload`, `src/renderer`), `docs-site/` (VitePress site, pt-BR and English), `scripts/` (repository tooling: package smoke test, release, and tests for the CI and packaging rules) and `release-notes/`. The full design is in `docs/superpowers/specs/` (Portuguese), and the manual test plan in [`docs/checklist-teste.md`](docs/checklist-teste.md).

### Packaging

```bash
npm run dist         # installer for the current OS in apps/desktop/dist
npm run smoke        # opens the packaged app in smoke mode and checks it exits with code 0
```

- **Windows:** `apps/desktop/dist/GhostLink-Setup-<version>.exe` (NSIS; per-user install, no administrator, in `%LOCALAPPDATA%\Programs\ghostlink`). `apps/desktop/dist/win-unpacked/` holds the same app, ready to run without installing.
- **macOS:** `apps/desktop/dist/GhostLink-<version>-mac-arm64.dmg` and `GhostLink-<version>-mac-x64.dmg`, ad-hoc signed.
- `npm run smoke` checks the Electron fuses (spec §12), looks in `app.asar` for optional dependencies replaced by stubs and opens the app with `GHOSTLINK_SMOKE=1` in a temporary profile. The app must load its window, start and stop the embedded server and exit with code 0 within 60 s.
- Installers are **not code-signed** (paid signing is outside the MVP). A downloaded installer makes SmartScreen warn ("More info" → "Run anyway"); on macOS 15 or newer, allow it in System Settings > Privacy & Security. None of this affects `npm run smoke`, which runs the app built on the same machine.
- `app.asar` is integrity-checked: any change after packaging makes the app refuse to start ("ASAR Integrity Violation").
- The app writes its log to `logs/main.log` in its data folder (`%APPDATA%\GhostLink` on Windows, `~/Library/Application Support/GhostLink` on macOS), rotated at 5 MB (one `main.old.log` is kept). In development the log also goes to the terminal. Tokens, passwords and codes must never be logged.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on pull requests and on demand:

- **test:** lint, typecheck and tests on Windows, Linux and macOS (Node 24);
- **package:** `npm run dist` and `npm run smoke` on Windows and macOS (on macOS, with a temporary keychain). Installers are kept as run artifacts for 7 days.

Actions are pinned by commit SHA and the token is read-only; `scripts/test/ciWorkflow.test.ts` enforces these rules.

`.github/workflows/docs.yml` publishes the site to GitHub Pages on every push to `main`.

## Releases

A protected `v<X.Y.Z>` tag triggers `.github/workflows/release.yml`:

1. checks that the tag, the `package.json` versions and `release-notes/<X.Y.Z>.md` agree;
2. builds the Windows installer (with LiveKit, the smoke test and the auto-update `latest.yml`) and `ghostlink-server-<X.Y.Z>.tgz` for VPS hosting;
3. after manual approval in the `release` environment, signs every file with the Ed25519 release key (which only exists as that environment's secret), writes `checksums-sha256.txt` and signs it with cosign keyless;
4. publishes the server's Docker image to `ghcr.io/gestao-in7eligente/ghostlink-server:<X.Y.Z>`, signed with cosign (the app creates Railway servers from it);
5. publishes a normal, *latest* release (never a pre-release: auto-update and `releases/latest` ignore pre-releases).

The public key is in `packages/shared/src/release.ts` (`RELEASE_PUBLIC_KEY`). The app only installs an update with a valid signature from that key.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute.
- [SECURITY.md](SECURITY.md): how to report a vulnerability **privately**.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
