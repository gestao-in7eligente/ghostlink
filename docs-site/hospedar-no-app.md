---
title: Hospedar no app
description: Transforme o seu computador num servidor GhostLink.
---

# Hospedar no app

No app, escolha **Hospedar um servidor**. O GhostLink roda o servidor no seu próprio computador, você vira o dono automaticamente e recebe um convite pronto para mandar.

## Como funciona

1. Escolha o nome do servidor, a porta (padrão 7700) e como as pessoas entram. O padrão é **só por convite**.
2. O app cria o certificado do servidor, inicia a voz, tenta abrir as portas no roteador (UPnP) e confere o firewall.
3. O painel mostra o **convite** (botão copiar), a **impressão digital** do servidor, os endereços e o estado das portas.

O botão de copiar copia o link `https://…/ghostlink/j/#GL1-…`, que funciona no WhatsApp, no Discord e no Telegram. Quem abrir o link entra direto pelo app.

O servidor continua no ar enquanto você conversa em outro servidor. Fechar a janela mantém o GhostLink na **bandeja** do Windows; para desligar o servidor, use **Sair** no menu da bandeja.

::: tip O servidor só funciona com o seu computador ligado
Para um servidor sempre no ar, use uma [VPS](./hospedar-em-vps).
:::

## Portas

| Porta | Protocolo | Para quê |
|---|---|---|
| **7700** | TCP | Conexão do app (texto, convites, controle) |
| **7882** | UDP | Áudio da voz |
| **7881** | TCP | Voz de reserva, para redes que bloqueiam UDP |

Se a porta 7700 já estiver em uso por outro programa, o app avisa e oferece a próxima livre (7710, 7720…). Convites antigos deixam de funcionar quando a porta muda.

## UPnP (abrir portas sozinho)

No Hospedar, o UPnP fica sempre ligado: o app pede ao roteador para encaminhar as três portas e descobre o seu IP público. Ao parar o servidor, o app desfaz o encaminhamento.

Se o roteador não tiver UPnP (ou estiver desligado), o app mostra o passo a passo para abrir as portas à mão:

1. Entre na página do roteador (geralmente `192.168.0.1` ou `192.168.1.1`).
2. Procure **Encaminhamento de portas**, **Port forwarding** ou **Servidor virtual**.
3. Encaminhe 7700/TCP, 7882/UDP e 7881/TCP para o IP do seu computador na rede local.

## Firewall do Windows

Na primeira vez, o Windows pergunta se o **GhostLink** e o **livekit-server.exe** (a voz) podem acessar a rede. Marque **redes privadas e públicas** e clique em **Permitir acesso**.

Se você recusou sem querer, use o botão **Corrigir firewall** no painel. Ele cria as regras certas e pede permissão de administrador uma vez.

## CGNAT: quando ninguém de fora consegue entrar

Algumas operadoras (principalmente de fibra e de celular) colocam vários clientes atrás do mesmo IP público. Isso se chama **CGNAT** e impede qualquer pessoa na internet de alcançar o seu computador, mesmo com as portas abertas. O app detecta e avisa.

Alternativas:

- **VPN entre vocês:** todo mundo instala a mesma VPN, como [Radmin VPN](https://www.radmin-vpn.com/), [Tailscale](https://tailscale.com/) ou [ZeroTier](https://www.zerotier.com/). O app detecta os endereços dessas VPNs e já os coloca no convite.
- **Pedir IP público à operadora:** algumas dão, às vezes pagando.
- **[Hospedar numa VPS](./hospedar-em-vps).**

## Quanto de internet

Na voz, cada pessoa envia o próprio áudio ao servidor e recebe o dos outros por ele. Em salas grandes, o **upload** de quem hospeda pesa. Para grupos grandes ou que ficam o dia todo, uma VPS é melhor.

## O que quem hospeda vê

Quem hospeda tem acesso a tudo o que passa pelo servidor: mensagens, áudio e o IP de quem conecta. E todos com o convite veem o IP de quem hospeda. Leia [Privacidade e segurança](./privacidade).

## Levar o servidor para uma VPS

Os dados do servidor ficam em `%APPDATA%\GhostLink\hosted\<servidor>\`. Copiar essa pasta para a pasta de dados da VPS (`/var/lib/ghostlink`) leva junto o certificado (e com ele a impressão digital), os membros, os cargos, os canais e as mensagens:

1. Pare o servidor no app e instale o GhostLink na VPS ([guia](./hospedar-em-vps)).
2. Na VPS, pare o serviço, troque o conteúdo de `/var/lib/ghostlink` pela pasta copiada e rode `chown -R ghostlink:ghostlink /var/lib/ghostlink`.
3. Inicie o serviço de novo e gere convites novos: os antigos apontam para o endereço da sua casa.
