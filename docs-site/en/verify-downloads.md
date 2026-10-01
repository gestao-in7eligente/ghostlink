---
title: Verify downloads
description: Check that a GhostLink download came from the official release.
---

# Verify downloads

Every GhostLink release is built by GitHub Actions from the public source and published with three ways to check it:

| File | What it proves |
|---|---|
| `checksums-sha256.txt` | The SHA-256 of every file in the release, by name. The names carry the version. |
| `checksums-sha256.txt.sigstore.json` | A **Sigstore (cosign)** signature: the checksums file came from this repository's `release.yml` workflow, for that tag. |
| `<file>.ed25519` | An **Ed25519** signature with GhostLink's release key. It is the same one the app checks before updating itself and that `install.sh` checks on a VPS. |

Download the file you want to check and the verification files from the [release page](https://github.com/gestao-in7eligente/ghostlink/releases/latest). In the examples, replace `0.3.0` with the version you downloaded.

## 1. Checksums with Sigstore (cosign)

With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) installed:

```bash
VERSION=0.3.0
cosign verify-blob checksums-sha256.txt \
  --bundle checksums-sha256.txt.sigstore.json \
  --certificate-identity "https://github.com/gestao-in7eligente/ghostlink/.github/workflows/release.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --ignore-missing -c checksums-sha256.txt
```

`cosign` must print `Verified OK`, and `sha256sum` must print `OK` for every file you downloaded.

On Windows (PowerShell), compare the installer's hash with its line in `checksums-sha256.txt`:

```powershell
$file = 'GhostLink-Setup-0.3.0.exe'
$expected = (Get-Content .\checksums-sha256.txt | Where-Object { $_.EndsWith("  $file") }).Split(' ')[0]
(Get-FileHash ".\$file" -Algorithm SHA256).Hash.ToLower() -eq $expected   # must print True
```

## 2. Release Ed25519 signature

Save the release public key as `ghostlink-release.pem`:

```text
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHhib591tl4P4Nf9us1fB5FCXXbGOZDBHwvWIu+2FWnc=
-----END PUBLIC KEY-----
```

Check the checksums file with OpenSSL 3 (on Windows, it comes with Git for Windows), then your files against it:

```bash
openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin \
  -in checksums-sha256.txt -sigfile checksums-sha256.txt.ed25519
sha256sum --ignore-missing -c checksums-sha256.txt
```

OpenSSL must print `Signature Verified Successfully`, and `sha256sum` must print `OK` for every file you downloaded. The signed list ties each file to its name, and the name to its version, so an older file cannot pass for a newer one. The app checks the same before it updates itself, and refuses any version that is not newer than the one installed.

Each file also has its own signature, checked the same way (`-in GhostLink-Setup-0.3.0.exe -sigfile GhostLink-Setup-0.3.0.exe.ed25519`). On its own, it proves that the release key signed those bytes, but not which version they are.

The key is also in the source code, in `packages/shared/src/release.ts` (`RELEASE_PUBLIC_KEY`, base64url). The private key exists only in a protected GitHub environment, used only by version tags and after manual approval.

## Why Windows still warns

Paid Microsoft code signing (Authenticode) is not part of the project yet. So SmartScreen warns the first time (**More info → Run anyway**), even for a verified file. The checks above are how you make sure the file is the official one.
