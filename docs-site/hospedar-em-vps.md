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

Baixe o `install.sh` da última release e, de preferência, confira o arquivo antes de rodar. Antes, salve a chave pública de release como `ghostlink-release.pem` (ela está em [Verificar downloads](./verificar-downloads)):

```bash
BASE=https://github.com/gestao-in7eligente/ghostlink/releases/latest/download
curl -fsSLO "$BASE/install.sh"
curl -fsSLO "$BASE/checksums-sha256.txt"
curl -fsSLO "$BASE/checksums-sha256.txt.ed25519"
openssl pkeyutl -verify -pubin -inkey ghostlink-release.pem -rawin \
  -in checksums-sha256.txt -sigfile checksums-sha256.txt.ed25519   # deve dizer "Signature Verified Successfully"
sha256sum --ignore-missing -c checksums-sha256.txt                  # deve dizer "install.sh: OK"
sudo bash install.sh
```

O script:

1. instala o Node.js 24 (NodeSource) e o ffmpeg (para o [Ghost DJ](#ghost-dj-bot-de-musica));
2. cria o usuário de sistema `ghostlink`;
3. baixa o `ghostlink-server-<versão>.tgz` da última release e confere o **checksum** e a **assinatura Ed25519 da release** (e o bundle Sigstore, se o `cosign` estiver instalado);
4. instala em `/opt/ghostlink` e baixa o servidor de voz (LiveKit), conferindo o SHA-256; os dados ficam em `/var/lib/ghostlink`;
5. descobre o IP público pela rota padrão, sem mandar pacote nenhum. Se a VPS só tiver IP privado (atrás de NAT do provedor), ele pergunta o IP público, ou você passa `--node-ip`:
   ```bash
   sudo bash install.sh --node-ip 203.0.113.10
   ```
6. cria um serviço `systemd` que reinicia sozinho, com o sistema de arquivos protegido e sem acesso às pastas pessoais;
7. abre as portas no `ufw`, se estiver ativo;
8. instala a **atualização automática** (veja [Atualizar](#atualizar));
9. mostra o **código de setup**, a **impressão digital** e um **convite**.

## Virar o dono

O código de setup faz de quem o usar primeiro o **dono** do servidor. Entre no servidor pelo app com o convite e informe o código de setup ao conectar. Ele vale uma vez só e é apagado depois de usado.

Guarde a impressão digital: quem entrar sem convite, só com o endereço, deve conferir se ela é igual à que o app mostra.

## Comandos úteis

O servidor roda como o usuário `ghostlink`. Para gerar outro convite (aqui com 10 usos e validade de 7 dias):

```bash
sudo -u ghostlink node /opt/ghostlink/current/dist/cli.js invite --data /var/lib/ghostlink --max-uses 10 --expires 7d
```

| Comando | Para quê |
|---|---|
| `invite [--max-uses N] [--expires 24h\|7d]` | Cria um convite (com o servidor rodando) |
| `status` | Versão, impressão digital e resumo dos membros |
| `setup-code` | Mostra o código de setup, se ainda não houver dono |
| `reset-owner` | Recupera a posse: gera um código de setup novo |
| `ghost-dj` | Confere o que o Ghost DJ precisa (ffmpeg, áudio do LiveKit, yt-dlp, cookies) |
| `version` | Versão do servidor |

Os convites também podem ser criados e revogados pelo app, em **Configurações do servidor → Convites**, por quem tem permissão.

## Ghost DJ (bot de música)

Todo servidor tem o **Ghost DJ**, que toca músicas do YouTube nos canais de voz com `/play`. Ele precisa do **ffmpeg**, que o `install.sh` instala; o próprio servidor baixa o `yt-dlp` oficial e confere o SHA-256. Para ver se está tudo certo:

```bash
sudo -u ghostlink node /opt/ghostlink/current/dist/cli.js ghost-dj --data /var/lib/ghostlink
```

Num servidor instalado antes da 0.5.0, a atualização automática não instala pacotes do sistema: rode uma vez `sudo apt install ffmpeg` (ou o `install.sh` de novo) e depois `sudo systemctl restart ghostlink`.

Se o `/play` disser que o **YouTube bloqueou o servidor** ("Sign in to confirm you're not a bot", comum em IPs de nuvem), exporte os cookies do YouTube de um navegador logado, no formato Netscape (`cookies.txt`), de preferência de uma conta separada, e coloque o arquivo na pasta do DJ. Não precisa reiniciar:

```bash
sudo -u ghostlink mkdir -p /var/lib/ghostlink/ghost-dj
sudo install -o ghostlink -g ghostlink -m 600 cookies.txt /var/lib/ghostlink/ghost-dj/cookies.txt
```

## Atualizar

O servidor acompanha a versão do app sozinho. A cada hora, o `ghostlink-update.timer` procura uma release nova. Quando encontra:

1. baixa e confere a versão nova do mesmo jeito que a instalação (checksums assinados e a assinatura Ed25519 da release) e a deixa pronta em `/opt/ghostlink/releases/<versão>`, sem mexer na que está rodando;
2. troca de versão e reinicia o servidor **só quando ninguém está em canal de voz**. Se em **24 horas** não houver um momento assim, troca mesmo assim: quem estiver em chamada cai por alguns segundos. Quem está no chat reconecta sozinho.

O LiveKit também é atualizado quando a versão nova pede outro. Os dados ficam.

Para ver quando roda e o que fez:

```bash
systemctl list-timers ghostlink-update.timer
journalctl -u ghostlink-update -n 50
```

Para procurar uma versão nova agora (a troca continua esperando ninguém estar em chamada):

```bash
sudo bash /opt/ghostlink/install.sh --auto-update
```

Para desligar a atualização automática, e para ligar de novo:

```bash
sudo bash /opt/ghostlink/install.sh --auto-update off
sudo bash /opt/ghostlink/install.sh --auto-update on
```

Para instalar já sem ela, use `sudo bash install.sh --no-auto-update`. A escolha fica guardada: rodar o `install.sh` de novo não muda.

Sem a atualização automática, atualize à mão: rode o `install.sh` da release mais recente de novo. Ele é idempotente: atualiza o servidor e mantém os dados.

Servidor em Docker, ou criado à mão no Railway? Veja [Docker e servidores criados à mão](./hospedar-no-railway#docker-e-servidores-criados-a-mao).

::: tip Servidores instalados antes da 0.2.2
A atualização automática chegou na 0.2.2. Num servidor mais antigo, rode uma vez o `install.sh` da release mais recente, como na instalação. Daí em diante ele se atualiza sozinho.
:::

## Vindo do Hospedar

Dá para levar um servidor que você hospedava no app para a VPS, com as mesmas pessoas e a mesma impressão digital. Veja [Levar o servidor para uma VPS](./hospedar-no-app#levar-o-servidor-para-uma-vps).
