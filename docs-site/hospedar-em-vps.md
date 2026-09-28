---
title: Hospedar numa VPS
description: Instale o servidor GhostLink numa VPS Linux com o install.sh.
---

# Hospedar numa VPS

Numa VPS, o servidor fica no ar o tempo todo, com IP fixo e sem depender do seu computador nem do seu roteador.

## Requisitos

- **Ubuntu 22.04 ou mais novo**, ou **Debian 12 ou mais novo**, em x64 ou arm64.
- Acesso de **root** (ou `sudo`).
- Um IP público.
- No painel do provedor (firewall da nuvem), libere **7700/TCP**, **7882/UDP** e **7881/TCP**. O script abre as mesmas portas no `ufw`, se ele estiver ativo.

Para poucas pessoas, a menor VPS costuma bastar. A voz passa toda pelo servidor, então olhe a banda incluída no plano.

## Instalar

Baixe o `install.sh` da última release e, de preferência, [confira o arquivo](./verificar-downloads) antes de rodar:

```bash
curl -fsSLO https://github.com/gestao-in7eligente/ghostlink/releases/latest/download/install.sh
curl -fsSLO https://github.com/gestao-in7eligente/ghostlink/releases/latest/download/checksums-sha256.txt
sha256sum --ignore-missing -c checksums-sha256.txt   # deve dizer "install.sh: OK"
sudo bash install.sh
```

O script:

1. instala o Node.js 24 (NodeSource);
2. cria o usuário de sistema `ghostlink`;
3. baixa o `ghostlink-server-<versão>.tgz` da última release e confere o **checksum** e a **assinatura Ed25519 da release** (e o bundle Sigstore, se o `cosign` estiver instalado);
4. instala em `/opt/ghostlink` e baixa o servidor de voz (LiveKit), conferindo o SHA-256; os dados ficam em `/var/lib/ghostlink`;
5. descobre o IP público pela rota padrão, sem mandar pacote nenhum. Se a VPS só tiver IP privado (atrás de NAT do provedor), ele pergunta o IP público, ou você passa `--node-ip`:
   ```bash
   sudo bash install.sh --node-ip 203.0.113.10
   ```
6. cria um serviço `systemd` que reinicia sozinho, com o sistema de arquivos protegido e sem acesso às pastas pessoais;
7. abre as portas no `ufw`, se estiver ativo;
8. mostra o **código de setup**, a **impressão digital** e um **convite**.

## Virar o dono

O código de setup faz de quem o usar primeiro o **dono** do servidor. Entre no servidor pelo app com o convite e informe o código de setup ao conectar. Ele vale uma vez só e é apagado depois de usado.

Guarde a impressão digital: quem entrar sem convite, só com o endereço, deve conferir se ela é igual à que o app mostra.

## Comandos úteis

O servidor roda como o usuário `ghostlink`. Para gerar outro convite (aqui com 10 usos e validade de 7 dias):

```bash
sudo -u ghostlink node /opt/ghostlink/dist/cli.js invite --data /var/lib/ghostlink --max-uses 10 --expires 7d
```

| Comando | Para quê |
|---|---|
| `invite [--max-uses N] [--expires 24h\|7d]` | Cria um convite (com o servidor rodando) |
| `status` | Versão, impressão digital e resumo dos membros |
| `setup-code` | Mostra o código de setup, se ainda não houver dono |
| `reset-owner` | Recupera a posse: gera um código de setup novo |
| `version` | Versão do servidor |

Os convites também podem ser criados e revogados pelo app, em **Configurações do servidor → Convites**, por quem tem permissão.

## Atualizar

Rode o `install.sh` da release mais recente de novo. Ele é idempotente: atualiza o servidor e mantém os dados.

## Vindo do Hospedar

Dá para levar um servidor que você hospedava no app para a VPS, com as mesmas pessoas e a mesma impressão digital. Veja [Levar o servidor para uma VPS](./hospedar-no-app#levar-o-servidor-para-uma-vps).
