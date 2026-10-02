---
title: Hospedar no Railway
description: Crie pelo app um servidor GhostLink que fica no ar 24 horas na sua conta Railway.
---

# Hospedar no Railway

O [Railway](https://railway.com) é um serviço de nuvem. O GhostLink cria o servidor **na sua própria conta**, sozinho: você não precisa de VPS, de abrir portas no roteador nem de deixar o computador ligado.

## O que você precisa

- Uma conta no Railway. Para o servidor ficar no ar o mês inteiro, use o plano **Hobby** (US$ 5 por mês, com US$ 5 de uso incluídos). Os planos Free e de teste param quando o crédito acaba, e o app avisa antes de criar.
- O GhostLink 0.2.0 ou mais novo.

## Passo a passo

1. No app, clique no **+** da barra da esquerda e escolha **Criar um servidor → Na nuvem (Railway)**.
2. Clique em **Abrir a página de tokens**, entre no Railway e crie um token. Em "Workspace", deixe **No workspace** (ou escolha o workspace onde o servidor vai ficar).
3. Cole o token no app e clique em **Conectar**.
4. Escolha o nome do servidor e a região. Para o Brasil, **EUA Leste (Virgínia)** costuma ter a menor latência.
5. Clique em **Criar servidor** e acompanhe as etapas. A mais demorada é "Publicando o servidor" (1 a 3 minutos). Você pode fechar a janela: o app continua.
6. No fim, o app entra no servidor como **dono**. Crie um convite pelo menu do servidor e mande para o grupo.

Se alguma etapa falhar, o app mostra o motivo e dois botões: **Tentar de novo** continua de onde parou, e **Excluir o que foi criado** apaga o projeto no Railway.

## O que o app cria na sua conta

| Item | Para quê |
|---|---|
| Um projeto `ghostlink-<nome>` | Separa o servidor dos seus outros projetos. O app não mexe em mais nada da conta. |
| Um serviço com a imagem `ghcr.io/gestao-in7eligente/ghostlink-server:<versão>` | O servidor GhostLink, na mesma versão do seu app. |
| Um volume em `/data` | Guarda a identidade do servidor (o certificado), as mensagens e as configurações. |
| Um proxy TCP | O endereço público, no formato `nome.proxy.rlwy.net:porta`. É ele que vai nos convites. |

## O token

- O token fica **criptografado no seu computador** e só é enviado à API do Railway. Ele nunca vai para nenhum servidor GhostLink.
- Para o app esquecer o token, use **Desconectar** na tela de criação. Os servidores já criados continuam no ar.
- Para cancelar o token de vez, apague-o na página de tokens do Railway.

## Voz no Railway

O Railway só oferece **uma porta TCP** por serviço e **nenhum UDP**. Por isso o servidor roda em **modo proxy**: a mesma porta carrega o texto e a voz, e toda a voz passa por TCP.

- Para conversar, funciona bem.
- Em conexões com perda de pacotes, a voz pode engasgar mais do que num servidor com UDP.
- Para câmera e tela (em versões futuras) e para grupos grandes, prefira [hospedar no app](./hospedar-no-app) ou [numa VPS](./hospedar-em-vps).

## Limites do modo proxy

Atrás do proxy, todas as conexões chegam ao servidor com o endereço do proxy, e não o de cada pessoa. Por isso:

- os limites contra abuso valem para o servidor inteiro, e não por IP;
- banir por IP não tem efeito. Banir a **pessoa** (pela identidade) funciona normalmente.

## Custos

O custo vai para a sua conta Railway. Um servidor pequeno usa pouca memória e processador e, em geral, cabe nos US$ 5 de uso do plano Hobby. A voz gasta tráfego de saída: um grupo de 5 pessoas conversando 3 horas por dia fica perto de US$ 1 por mês.

## Atualizar

O servidor que o app criou acompanha a versão do **app do dono** (GhostLink 0.2.2 ou mais novo). Com o app aberto e o Railway conectado, ele confere a versão do servidor logo depois de se atualizar e a cada 30 minutos. Se o servidor está numa versão mais antiga, o app troca a imagem do serviço para a versão dele e publica de novo:

- **só quando ninguém está em canal de voz**. Se em 24 horas não houver um momento assim, atualiza mesmo assim. Quem está no chat reconecta sozinho;
- o volume e as configurações do serviço ficam.

Enquanto o servidor espera, o dono vê no topo do chat: "Este servidor está na 0.2.0. Ele será atualizado para a 0.2.2 quando ninguém estiver em chamada." **Atualizar agora** não espera: quem estiver em chamada cai por alguns segundos. Se o token do Railway foi desconectado, o app pede para conectar de novo.

### Docker e servidores criados à mão

O app só atualiza os servidores que ele mesmo criou. Num servidor em Docker, ou criado à mão no Railway, use a imagem `ghcr.io/gestao-in7eligente/ghostlink-server:latest`: a tag `latest` sempre aponta para a versão mais recente (a mesma imagem assinada da tag com o número).

- **À mão:** baixe a imagem de novo e recrie o contêiner (no Railway, publique o serviço de novo). O volume em `/data` mantém os dados.
- **Sozinho, com o Watchtower:** ele baixa a imagem nova e recria o contêiner. Ele não sabe se alguém está em chamada, então escolha um horário tranquilo. Por exemplo, todo dia às 5h, para o contêiner `ghostlink`:

```bash
docker run -d --name watchtower --restart unless-stopped   -v /var/run/docker.sock:/var/run/docker.sock   containrrr/watchtower --schedule "0 0 5 * * *" ghostlink   # confere todo dia às 5h
```

## Ghost DJ e o bloqueio do YouTube

A imagem já traz o ffmpeg: com a voz ligada, o **Ghost DJ** (o bot de música, `/play`) funciona sem configurar nada. O YouTube costuma bloquear IPs de nuvem como os do Railway ("Sign in to confirm you're not a bot"), e o `/play` avisa quando isso acontece. Para resolver, exporte os cookies do YouTube de um navegador logado, no formato Netscape (`cookies.txt`), de preferência de uma conta separada, e coloque o arquivo em `/data/ghost-dj/cookies.txt` (por exemplo, pelo `railway ssh`, colando o conteúdo em `cat > /data/ghost-dj/cookies.txt`). Não precisa reiniciar.

## Reiniciar e apagar

No painel do Railway:

- **Reiniciar:** use "Restart" no serviço.
- **Apagar:** apague o projeto. Os dados somem com ele (o Railway permite restaurar por 48 horas).

::: warning O endereço é o que está nos convites
Não apague nem recrie o proxy TCP do serviço: o Railway sorteia outro endereço e os convites antigos param de funcionar.
:::
