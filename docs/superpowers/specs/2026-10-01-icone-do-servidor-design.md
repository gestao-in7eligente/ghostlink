# GhostLink — Ícone do servidor

Desenho aprovado pelo dono em 2026-10-01 ("Os servidores devem ter as fotos de perfil também… você já tem o caminho"). Reaproveita a foto de perfil ([`2026-10-01-foto-de-perfil-design.md`](2026-10-01-foto-de-perfil-design.md)).

- **Onde:** Configurações do servidor → Visão geral → **Ícone do servidor** (Alterar / Remover), com o mesmo modal de recorte (zoom, arrastar, GIF animado) e os mesmos limites (256×256, até 2 MB).
- **Quem:** quem tem `MANAGE_SERVER` (o dono sempre).
- **Servidor:** `upload.begin { purpose: 'icon', size, sha256 }` (MANAGE_SERVER) → o mesmo `POST /upload`, que grava o hash em `server_meta.icon` e manda `server.updated` com `icon`; `server.iconClear {}` volta às iniciais. `ServerInfo` (welcome e `server.updated`) ganha `icon: string | null`. O `GET /avatars/<hash>` também serve o hash do ícone atual. `features` ganha `serverIcon`. Limpeza de arquivo órfão como nos avatares.
- **App:** o servidor salvo guarda `iconHash` (atualizado no welcome e em `server.updated`); o ícone é mostrado pelo mesmo `app://ghostlink/_avatar/<hash>` (cache em disco), então o trilho mostra o ícone até de servidores que não estão abertos. Aparece no trilho, no cabeçalho do servidor, no "Ativo agora" e nos convites; sem ícone, as iniciais.
- **Testes (enxutos, a pedido do dono):** o schema; no servidor, envio com e sem permissão e o `server.updated`; um e2e: Ana troca o ícone e Bia vê no trilho.
