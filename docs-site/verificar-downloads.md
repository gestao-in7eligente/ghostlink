---
title: Verificar downloads
description: Confira que um download do GhostLink veio da release oficial.
---

# Verificar downloads

Cada release do GhostLink é gerada pelo GitHub Actions a partir do código público e publicada com três formas de conferência:

| Arquivo | O que prova |
|---|---|
| `checksums-sha256.txt` | O SHA-256 de todos os arquivos da release, por nome. Os nomes trazem a versão. |
| `checksums-sha256.txt.sigstore.json` | Assinatura **Sigstore (cosign)**: o arquivo de checksums saiu do workflow `release.yml` deste repositório, para aquela tag. |
| `<arquivo>.ed25519` | Assinatura **Ed25519** com a chave de release do GhostLink. É a mesma que o app confere antes de se atualizar e que o `install.sh` confere na VPS. |

Baixe da [página da release](https://github.com/gestao-in7eligente/ghostlink/releases/latest) o arquivo que você quer conferir e os arquivos de conferência. Nos exemplos, troque `0.7.0` pela versão que você baixou.

## 1. Checksums com Sigstore (cosign)

Com o [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) instalado:

```bash
VERSION=0.7.0
cosign verify-blob checksums-sha256.txt \
  --bundle checksums-sha256.txt.sigstore.json \
  --certificate-identity "https://github.com/gestao-in7eligente/ghostlink/.github/workflows/release.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --ignore-missing -c checksums-sha256.txt
```

O `cosign` precisa dizer `Verified OK`, e o `sha256sum`, `OK` para cada arquivo baixado.

No Windows (PowerShell), compare o hash do instalador com a linha dele no `checksums-sha256.txt`:

```powershell
$file = 'GhostLink-Setup-0.7.0.exe'
$expected = (Get-Content .\checksums-sha256.txt | Where-Object { $_.EndsWith("  $file") }).Split(' ')[0]
(Get-FileHash ".\$file" -Algorithm SHA256).Hash.ToLower() -eq $expected   # deve dizer True
```

## 2. Assinatura Ed25519 da release

Salve a chave pública de release como `ghostlink-release.pem`:

```text
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHhib591tl4P4Nf9us1fB5FCXXbGOZDBHwvWIu+2FWnc=
-----END PUBLIC KEY-----
```

Confira o arquivo de checksums com o OpenSSL 3 (no Windows, ele vem com o Git for Windows) e, depois, os seus arquivos contra ele:

```bash
openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin \
  -in checksums-sha256.txt -sigfile checksums-sha256.txt.ed25519
sha256sum --ignore-missing -c checksums-sha256.txt
```

O OpenSSL precisa dizer `Signature Verified Successfully`, e o `sha256sum` precisa dizer `OK` para cada arquivo que você baixou. A lista assinada amarra cada arquivo ao nome dele, e o nome à versão, então um arquivo antigo não passa por um mais novo. O app confere a mesma coisa antes de se atualizar e recusa qualquer versão que não seja mais nova que a instalada.

Cada arquivo também tem a própria assinatura, conferida do mesmo jeito (`-in GhostLink-Setup-0.7.0.exe -sigfile GhostLink-Setup-0.7.0.exe.ed25519`). Sozinha, ela prova que a chave de release assinou aqueles bytes, mas não diz de qual versão eles são.

A chave também está no código-fonte, em `packages/shared/src/release.ts` (`RELEASE_PUBLIC_KEY`, em base64url). A chave privada existe só num ambiente protegido do GitHub, usado apenas por tags de versão e com aprovação manual.

## Por que o Windows avisa mesmo assim

A assinatura de código paga da Microsoft (Authenticode) ainda não faz parte do projeto. Por isso o SmartScreen avisa na primeira vez (**Mais informações → Executar assim mesmo**), mesmo com o arquivo verificado. As conferências acima são a forma de ter certeza de que o arquivo é o oficial.
