# GhostLink

App desktop gratuito e de código aberto (Windows e macOS) para chat de texto, voz, câmera e tela, no estilo do Discord — sem conta central. Qualquer pessoa pode hospedar o próprio servidor, pelo app ou numa VPS.

> **Status:** em desenvolvimento (Milestone 1: fundação). Ainda não há release.

## Desenvolvimento

Requisitos: Node.js 24.14 ou mais novo.

```bash
npm install          # instala todos os workspaces
npm test             # testes de unidade e integração (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript em todos os pacotes
npm run build        # gera apps/server/dist/cli.js (servidor para VPS)
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`). O design completo está em `docs/superpowers/specs/`.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
