---
title: Baixar
description: Baixe o GhostLink para Windows.
---

<script setup>
import DownloadButton from './.vitepress/theme/components/DownloadButton.vue';
</script>

# Baixar o GhostLink

<DownloadButton />

O instalador é o `GhostLink-Setup-<versão>.exe` da [última release no GitHub](https://github.com/gestao-in7eligente/ghostlink/releases/latest). Ele instala o app só para o seu usuário, sem pedir administrador.

## Aviso do Windows (SmartScreen)

O GhostLink ainda não tem um certificado de assinatura de código pago. Por isso, na primeira vez, o Windows mostra **"O Windows protegeu o computador"**:

1. Clique em **Mais informações**.
2. Clique em **Executar assim mesmo**.

Se quiser ter certeza de que o arquivo é o mesmo que o GitHub Actions gerou e assinou, [verifique o download](./verificar-downloads) antes de abrir.

## Requisitos

- **Windows 10 ou 11, 64 bits.**
- **macOS:** ainda não. O app para Mac vem numa próxima versão.
- **Linux:** só o servidor, para [hospedar numa VPS](./hospedar-em-vps).

## Atualizações

No Windows, o app procura versões novas ao abrir e a cada 6 horas, baixa em segundo plano e mostra **"Nova versão X baixada — Reiniciar para atualizar"**. Antes de instalar, ele confere a assinatura Ed25519 da release: um arquivo sem essa assinatura nunca é instalado. Dá para desligar a procura automática nas configurações, em **Atualizações**.

Todas as versões ficam na [página de releases](https://github.com/gestao-in7eligente/ghostlink/releases).
