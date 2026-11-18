---
title: Baixar
description: Baixe o GhostLink para Windows e Linux.
---

<script setup>
import DownloadButton from './.vitepress/theme/components/DownloadButton.vue';
</script>

# Baixar o GhostLink

<DownloadButton />
<DownloadButton os="linux" />

No Windows, o instalador é o `GhostLink-Setup-<versão>.exe` da [última release no GitHub](https://github.com/gestao-in7eligente/ghostlink/releases/latest). Ele instala o app só para o seu usuário, sem pedir administrador.

## Aviso do Windows (SmartScreen)

O GhostLink ainda não tem um certificado de assinatura de código pago. Por isso, na primeira vez, o Windows mostra **"O Windows protegeu o computador"**:

1. Clique em **Mais informações**.
2. Clique em **Executar assim mesmo**.

Se quiser ter certeza de que o arquivo é o mesmo que o GitHub Actions gerou e assinou, [verifique o download](./verificar-downloads) antes de abrir.

## Linux (AppImage)

O arquivo é o `GhostLink-<versão>-linux-x86_64.AppImage`, da mesma release. Funciona em qualquer distribuição x86_64 recente (Arch, Fedora, Ubuntu…):

```bash
chmod +x GhostLink-*-linux-x86_64.AppImage
./GhostLink-*-linux-x86_64.AppImage
```

- A chave da sua identidade é guardada cifrada pelo chaveiro do sistema (KWallet, GNOME Keyring ou outro que implemente o Secret Service). Sem chaveiro, o app não consegue criar a identidade.
- Funciona em Wayland e X11. O compartilhamento de tela no Wayland usa o PipeWire e o `xdg-desktop-portal` da sua sessão.
- Se o AppImage reclamar de FUSE, instale o `fuse2` ou rode com `--appimage-extract-and-run`.
- Também há um `GhostLink-<versão>-linux-x64.tar.gz`, para quem prefere não usar AppImage. Ele é a base do pacote `ghostlink-bin` do AUR.

## Requisitos

- **Windows 10 ou 11, 64 bits.**
- **Linux x86_64** com glibc recente, chaveiro do sistema e, para áudio, PipeWire ou PulseAudio.
- **macOS:** ainda não. O app para Mac vem numa próxima versão.
- O servidor também roda numa [VPS Linux](./hospedar-em-vps).

## Atualizações

No Windows e no AppImage, o app procura versões novas ao abrir e a cada 6 horas, baixa em segundo plano e mostra **"Nova versão X baixada — Reiniciar para atualizar"**. Antes de instalar, ele confere as assinaturas Ed25519 da release e se o instalador é exatamente o listado para aquela versão: um arquivo sem essas assinaturas nunca é instalado, e o app nunca volta para uma versão mais antiga. Dá para desligar a procura automática nas configurações, em **Atualizações**.

Todas as versões ficam na [página de releases](https://github.com/gestao-in7eligente/ghostlink/releases).
