<p align="center"><img src="docs-site/public/logo.svg" width="96" height="96" alt=""></p>

<h1 align="center">GhostLink</h1>

<p align="center">
  Chat de texto e voz no estilo do Discord, com servidor próprio e sem conta.<br>
  <a href="https://gestao-in7eligente.github.io/ghostlink/download"><b>Baixar para Windows</b></a> ·
  <a href="https://gestao-in7eligente.github.io/ghostlink/">Site</a> ·
  <a href="README.en.md">English</a>
</p>

GhostLink é um app desktop gratuito e de código aberto para chat de texto e voz. **Qualquer pessoa hospeda o próprio servidor**: no próprio computador, na nuvem (o app cria o servidor na sua conta Railway) ou numa VPS Linux. Não existe conta nem servidor central: sua identidade é uma chave que fica no seu computador, e cada servidor recebe uma chave derivada diferente.

> **Beta (0.x).** Por enquanto só para Windows. Amigos e mensagens diretas, câmera, compartilhamento de tela, arquivos e o app para macOS vêm nas próximas versões.

## O que tem na 0.2

- **Texto:** canais, histórico, respostas, edição, reações, menções, não lidas, markdown seguro e notificações.
- **Voz** (LiveKit): mutar, ensurdecer, indicador de fala, dispositivos, volume por pessoa e push-to-talk (global no Windows).
- **Cargos e moderação:** permissões aplicadas pelo servidor, canais privados, convites com limite e validade, expulsar, banir, transferir e recuperar a posse.
- **Hospedar:** no app, com UPnP, detecção de CGNAT e correção do firewall; na nuvem, com um servidor criado pelo app na sua conta Railway; ou numa VPS com `install.sh`.
- **Segurança:** TLS com o certificado do servidor fixado, identidade só no dispositivo, backup `.ghostkey`, sem telemetria, atualização automática conferida com Ed25519.

Leia [Privacidade e segurança](https://gestao-in7eligente.github.io/ghostlink/privacidade) antes de usar: **quem hospeda o servidor vê o que passa por ele** (não há criptografia ponta a ponta).

## Capturas de tela

_Em breve._

## Baixar e verificar

O instalador (`GhostLink-Setup-<versão>.exe`) está nas [releases](https://github.com/gestao-in7eligente/ghostlink/releases/latest). Como ele ainda não tem assinatura de código paga, o SmartScreen avisa na primeira vez: **Mais informações → Executar assim mesmo**.

Cada release traz `checksums-sha256.txt`, assinado com Sigstore (cosign keyless) e com a chave de release Ed25519, e uma assinatura `.ed25519` para cada arquivo. Veja [Verificar downloads](https://gestao-in7eligente.github.io/ghostlink/verificar-downloads).

## Desenvolvimento

Requisitos: Node.js 24.14 ou mais novo. O app desktop roda e é empacotado no Windows e no macOS; o servidor e os testes também rodam no Linux.

```bash
npm install          # instala todos os workspaces
npm test             # testes de unidade e integração (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript em todos os pacotes, em scripts/ e no site
npm run build        # typecheck + servidor (apps/server/dist/cli.js) + app (apps/desktop/out)
npm run dev          # abre o app em modo de desenvolvimento (electron-vite)
npm run smoke:dev    # abre o app compilado com GHOSTLINK_SMOKE=1 e confere que ele sobe e fecha sozinho
npm run docs:dev     # site (VitePress) em http://localhost:5173/ghostlink/
npm run docs:build   # gera o site em docs-site/.vitepress/dist
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

O binário do Electron é baixado na primeira vez que é usado (ou com `node node_modules/electron/install.js`). No terminal do VS Code, a variável `ELECTRON_RUN_AS_NODE=1` faz o Electron virar Node puro; por isso todo comando que abre o app passa por `scripts/run-electron.mjs` (ou, no app empacotado, pelo `npm run smoke`), que remove essa variável. O app empacotado ignora a variável de qualquer jeito (fuse `runAsNode` desligado).

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`), `apps/desktop` (app Electron: `src/main`, `src/preload`, `src/renderer`), `docs-site/` (site VitePress, pt-BR e inglês), `scripts/` (ferramentas do repositório: smoke test do pacote, release e testes das regras de CI e empacotamento) e `release-notes/`. O design completo está em `docs/superpowers/specs/`, e o roteiro de teste manual em [`docs/checklist-teste.md`](docs/checklist-teste.md).

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

O `.github/workflows/docs.yml` publica o site no GitHub Pages a cada push na `main`.

## Releases

Uma tag protegida `v<X.Y.Z>` dispara o `.github/workflows/release.yml`:

1. confere que a tag, as versões dos `package.json` e `release-notes/<X.Y.Z>.md` batem;
2. gera o instalador do Windows (com o LiveKit, o smoke test e o `latest.yml` do auto-update) e o `ghostlink-server-<X.Y.Z>.tgz` para VPS;
3. depois da aprovação manual no ambiente `release`, assina cada arquivo com a chave Ed25519 de release (que só existe como segredo desse ambiente), gera o `checksums-sha256.txt` e assina com cosign keyless;
4. publica a imagem Docker do servidor em `ghcr.io/gestao-in7eligente/ghostlink-server:<X.Y.Z>`, assinada com cosign (é dela que o app cria servidores no Railway);
5. publica a release como normal e *latest* (nunca pre-release: o auto-update e o `releases/latest` ignoram pre-releases).

A chave pública fica em `packages/shared/src/release.ts` (`RELEASE_PUBLIC_KEY`). O app só instala uma atualização com assinatura válida dessa chave.

## Contribuir e segurança

- [CONTRIBUTING.md](CONTRIBUTING.md): como contribuir.
- [SECURITY.md](SECURITY.md): como relatar uma vulnerabilidade **em privado**.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
