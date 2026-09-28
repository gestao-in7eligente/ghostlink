# GhostLink

App desktop gratuito e de código aberto (Windows e macOS) para chat de texto, voz, câmera e tela, no estilo do Discord — sem conta central. Qualquer pessoa pode hospedar o próprio servidor, pelo app ou numa VPS.

> **Status:** em desenvolvimento (Milestone 1: fundação). Ainda não há release.

## Desenvolvimento

Requisitos: Node.js 24.14 ou mais novo. O app desktop roda e é empacotado no Windows e no macOS; o servidor e os testes também rodam no Linux.

```bash
npm install          # instala todos os workspaces
npm test             # testes de unidade e integração (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript em todos os pacotes e em scripts/
npm run build        # typecheck + servidor (apps/server/dist/cli.js) + app (apps/desktop/out)
npm run dev          # abre o app em modo de desenvolvimento (electron-vite)
npm run smoke:dev    # abre o app compilado com GHOSTLINK_SMOKE=1 e confere que ele sobe e fecha sozinho
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

O binário do Electron é baixado na primeira vez que é usado (ou com `node node_modules/electron/install.js`). No terminal do VS Code, a variável `ELECTRON_RUN_AS_NODE=1` faz o Electron virar Node puro; por isso todo comando que abre o app passa por `scripts/run-electron.mjs` (ou, no app empacotado, pelo `npm run smoke`), que remove essa variável. O app empacotado ignora a variável de qualquer jeito (fuse `runAsNode` desligado).

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`), `apps/desktop` (app Electron: `src/main`, `src/preload`, `src/renderer`) e `scripts/` (ferramentas do repositório: smoke test do pacote e testes das regras de CI e empacotamento). O design completo está em `docs/superpowers/specs/`.

### Empacotar

```bash
npm run dist         # instalador do sistema atual em apps/desktop/dist
npm run smoke        # abre o app empacotado em modo smoke e confere que ele sai com código 0
```

- **Windows:** `apps/desktop/dist/GhostLink-Setup-<versão>.exe` (NSIS; instala só para o usuário atual, sem pedir administrador, em `%LOCALAPPDATA%\Programs\ghostlink`). A pasta `apps/desktop/dist/win-unpacked/` tem o mesmo app, pronto para rodar sem instalar.
- **macOS:** `apps/desktop/dist/GhostLink-<versão>-mac-arm64.dmg` e `GhostLink-<versão>-mac-x64.dmg`, com assinatura ad-hoc.
- O `npm run smoke` confere os fuses do Electron (spec §12), procura no `app.asar` dependências opcionais trocadas por stubs e abre o app com `GHOSTLINK_SMOKE=1` num perfil temporário. O app precisa carregar a janela, iniciar e parar o servidor embutido e sair com código 0 em até 60 s.
- Os instaladores **não são assinados** (a assinatura paga fica fora do MVP). Um instalador baixado da internet faz o SmartScreen avisar ("Mais informações" → "Executar assim mesmo"); no macOS 15 ou mais novo, libere em Ajustes do Sistema > Privacidade e Segurança. Nada disso afeta o `npm run smoke`, que roda o app gerado na própria máquina.
- O `app.asar` é protegido por checagem de integridade: qualquer alteração depois do empacotamento faz o app recusar abrir ("ASAR Integrity Violation").
- O app grava o log em `logs/main.log` dentro da pasta de dados (`%APPDATA%\GhostLink` no Windows, `~/Library/Application Support/GhostLink` no macOS), com rotação em 5 MB (fica um `main.old.log`). Em desenvolvimento o log também aparece no terminal. Tokens, senhas e códigos nunca devem ser registrados.

## Integração contínua

O `.github/workflows/ci.yml` roda em todo push na `main`, em pull requests e sob demanda:

- **test:** lint, typecheck e testes no Windows, Linux e macOS (Node 24);
- **package:** `npm run dist` e `npm run smoke` no Windows e no macOS (no macOS, com um keychain temporário). Os instaladores ficam como artefatos da execução por 7 dias.

As actions são fixadas por SHA de commit e o token só tem leitura; `scripts/test/ciWorkflow.test.ts` confere essas regras.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
