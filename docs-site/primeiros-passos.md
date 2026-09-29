---
title: Primeiros passos
description: Instale o GhostLink, crie sua identidade e entre num servidor.
---

# Primeiros passos

## 1. Instale o app

[Baixe o instalador para Windows](./download) e abra. Na primeira vez, o SmartScreen pode avisar: clique em **Mais informações → Executar assim mesmo**.

## 2. Sua identidade

O GhostLink **não tem conta**. Na primeira abertura, o app cria uma chave criptográfica que fica só no seu computador, guardada cifrada pelo Windows. É ela que prova quem você é em cada servidor. Cada servidor recebe uma chave derivada diferente, então dois servidores não conseguem ligar uma conta à outra.

Depois você escolhe o idioma e um apelido. O apelido pode ser trocado em cada servidor.

::: warning Faça um backup
Sem backup, **perder o computador é perder a identidade**: você volta aos servidores como outra pessoa, sem seus cargos. Exporte a identidade (o app oferece isso na primeira abertura e nas configurações): isso gera um arquivo `.ghostkey` protegido por uma senha que você escolhe. Guarde o arquivo e a senha em lugares diferentes. Para usar a mesma identidade em outro computador, importe o arquivo.
:::

## 3. Entre num servidor

Quem hospeda um servidor (ou um administrador dele) manda um **convite**. Há três jeitos de usar:

- **Link do convite** (`https://gestao-in7eligente.github.io/ghostlink/j/#GL1-…`): abra no navegador. A página abre o GhostLink direto no convite. Se você ainda não tem o app, ela mostra o download e o código para colar depois.
- **Código `GL1-…`**: no app, escolha **Entrar num servidor** e cole.
- **Endereço `host:porta`**, sem convite: funciona só em servidores abertos ou com senha. O app mostra a **impressão digital** do servidor (quatro grupos de oito caracteres). Peça ao dono a impressão digital por outro canal e confira antes de continuar: é isso que garante que você está falando com o servidor certo.

Com convite, o app já recebe a impressão digital junto e confere sozinho.

::: danger Se o app avisar que a chave do servidor mudou
Não continue sem falar com o dono. Pode ser um servidor falso no lugar do verdadeiro.
:::

A barra da esquerda guarda os servidores em que você entrou. O app fica conectado a um servidor por vez.

## 4. Converse

- **Texto:** escreva no canal e aperte **Enter** (Shift+Enter quebra a linha). Dá para responder, reagir, editar e apagar as suas mensagens e mencionar alguém com `@`. O texto aceita markdown leve, como `**negrito**` e blocos de código.
- **Voz:** clique numa sala de voz para entrar. No painel de baixo você muta o microfone, ensurdece e escolhe os dispositivos de entrada e saída. Dá para ajustar o volume de cada pessoa e usar push-to-talk, inclusive com outro programa (um jogo) em foco.

O que cada pessoa pode fazer depende dos **cargos** que o servidor dá a ela. Tudo é conferido pelo servidor, não só escondido na tela.

## 5. Hospede o seu

Qualquer pessoa pode criar um servidor. Veja [Hospedar no app](./hospedar-no-app) (mais fácil) ou [Hospedar numa VPS](./hospedar-em-vps) (sempre no ar).
