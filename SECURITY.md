# Security policy / Política de segurança

GhostLink handles identity keys, runs a TLS server exposed to the internet and enforces permissions, so security reports are very welcome.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub Security Advisories:
**[Report a vulnerability](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new)** (repository → Security → Advisories → *Report a vulnerability*).

If that form is not available, open an issue titled only "Security contact request", **with no details**, and a maintainer will reply with a private channel.

Please include:

- the affected version (app or server) and your OS;
- what an attacker can do and under which conditions (for example: another member of the server, the server host, someone on the network, a malicious invite link);
- steps to reproduce or a proof of concept;
- whether the issue is already public.

We aim to acknowledge a report within 7 days and to keep you updated until it is fixed. With your permission, we credit you in the release notes.

## Supported versions

GhostLink is in beta (0.x). Only the **latest release** receives security fixes; the Windows app updates itself automatically. Self-hosted servers must be updated by their host (in the app, by updating the app; on a VPS, by running the latest `install.sh` again).

## Scope

In scope, among others: the desktop app (Electron main, preload and renderer), the server and its CLI, the invite and join flow, `install.sh`, the release pipeline and signing, the auto-updater and the website (including the `/j/` invite page).

Known and documented limits (see the [privacy page](https://gestao-in7eligente.github.io/ghostlink/en/privacy)) are not vulnerabilities by themselves: the host of a server can read what goes through it (no end-to-end encryption), hosting exposes the host's IP to invitees, message IDs reveal the total message volume, and Windows installers are not Authenticode-signed yet.

## Verifying releases

Every release file has a detached Ed25519 signature (`<file>.ed25519`) made with the release key whose public half is `RELEASE_PUBLIC_KEY` in `packages/shared/src/release.ts`, and `checksums-sha256.txt` is also signed with Sigstore (cosign keyless) by `.github/workflows/release.yml`. See [Verify downloads](https://gestao-in7eligente.github.io/ghostlink/en/verify-downloads).

---

## Português

**Não abra uma issue, discussão ou pull request público para um problema de segurança.** Relate em privado pelo GitHub Security Advisories: **[Relatar uma vulnerabilidade](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new)**. Se o formulário não estiver disponível, abra uma issue com o título "Security contact request", **sem nenhum detalhe**, e um mantenedor responde com um canal privado.

Inclua a versão afetada, o que um atacante consegue fazer e em que condições, os passos para reproduzir e se o problema já é público. Respondemos em até 7 dias. Só a **última release** recebe correções de segurança.
