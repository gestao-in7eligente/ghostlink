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
npm run build        # typecheck + servidor (apps/server/dist/cli.js) + app (apps/desktop/out)
npm run dev          # abre o app em modo de desenvolvimento (electron-vite)
npm run smoke:dev    # abre o app compilado com GHOSTLINK_SMOKE=1 e confere que ele sobe e fecha sozinho
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

O binário do Electron é baixado na primeira vez que é usado (ou com `node node_modules/electron/install.js`). No terminal do VS Code, a variável `ELECTRON_RUN_AS_NODE=1` faz o Electron virar Node puro; por isso todo comando que abre o app passa por `scripts/run-electron.mjs`, que remove essa variável.

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`), `apps/desktop` (app Electron: `src/main`, `src/preload`, `src/renderer`). O design completo está em `docs/superpowers/specs/`.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
