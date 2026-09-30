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

## Atualizar, reiniciar e apagar

Por enquanto, isso é feito no painel do Railway:

- **Atualizar:** no serviço, troque a versão no fim do nome da imagem (por exemplo `:0.2.0` para a versão nova) e publique de novo. O volume mantém os dados.
- **Reiniciar:** use "Restart" no serviço.
- **Apagar:** apague o projeto. Os dados somem com ele (o Railway permite restaurar por 48 horas).

::: warning O endereço é o que está nos convites
Não apague nem recrie o proxy TCP do serviço: o Railway sorteia outro endereço e os convites antigos param de funcionar.
:::
