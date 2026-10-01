# GhostLink — Atualizar ao abrir

Desenho aprovado pelo dono em 2026-10-01 ("toda vez que abrir o ghostlink, verificar se tem versão nova e atualizar"). Muda a spec principal §15 (atualizações automáticas). Onde este documento não diz nada, ela continua valendo.

## 1. O problema

Hoje o app verifica 10 s depois de abrir e a cada 6 h, baixa sozinho e confere a assinatura Ed25519 (`updaterSignature.ts`). Mas só **instala ao sair de verdade** (`autoInstallOnAppQuit`) ou quando a pessoa clica em "Reiniciar para atualizar". Quem hospeda fecha a janela e o app fica na bandeja; quem só fecha e abre de novo pode nunca passar pela saída que instala. Resultado: gente em versão velha, baixando o instalador de novo à mão.

## 2. O que muda

**Ao abrir** (só no app instalado do Windows, com "Verificar atualizações automaticamente" ligado, fora do modo smoke):

1. Antes da janela principal, abre uma **janela de abertura** pequena, sem moldura, como a do Discord: o fantasma, "GhostLink" e uma linha de estado.
2. Ela mostra **"Procurando atualizações…"** e o main chama `checkForUpdates()`.
3. O que acontece em seguida:
   - **Não tem versão nova, deu erro, está sem internet, ou a verificação passou de 10 s:** a janela de abertura fecha e o app abre normal. O resto do app não espera mais nada.
   - **Tem versão nova:** "Baixando atualização… 42%", com a barra de progresso.
     - Baixou e a assinatura confere: "Instalando…", e o main chama `quitAndInstall(true, true)`. O instalador roda em silêncio e reabre o GhostLink já atualizado.
     - A assinatura não confere (`rejected`): o arquivo é descartado como hoje, e o app abre normal, com o aviso de sempre.
     - Depois de **20 s** baixando aparece o link **"Abrir sem atualizar"**. Ele fecha a janela de abertura e abre o app; o download continua em segundo plano e vale a regra de "já aberto".
   - **Já havia uma atualização baixada** (de uma sessão anterior): pula direto para "Instalando…".
4. Um link do tipo `ghostlink://` que chegou na abertura não se perde: ele já fica guardado em `DeepLinks` e a página o pega quando abrir (depois da reinstalação, o Windows não repassa o link; a pessoa clica de novo — aceitável).

**Já aberto:** nada muda. Continua verificando a cada 6 h, baixando em segundo plano e mostrando "Reiniciar para atualizar". Se a pessoa não reiniciar, a próxima abertura instala (passo 3, "já havia uma atualização baixada").

**Desligado nas configurações:** não há janela de abertura nem verificação, como hoje.

**Desenvolvimento, smoke e fora do app instalado:** o updater já fica `unsupported`; a janela de abertura nunca aparece.

## 3. Como

- `updater.ts` ganha `checkAtStartup({ checkTimeoutMs: 10_000, skipAfterMs: 20_000 })`, que devolve uma promessa resolvida com `'continue'` (abrir o app) ou `'installing'` (o app vai fechar), e relata o estado à janela de abertura. Os estados `checking`, `downloading` e `downloaded` são os de hoje; o que muda é quem decide instalar.
- A janela de abertura é um `BrowserWindow` de 300×340, sem moldura, sem `nodeIntegration`, com uma página estática do próprio app (`app://ghostlink/splash.html`), um preload mínimo que só recebe o estado e envia "Abrir sem atualizar". Cores e fantasma da paleta do app.
- `index.ts`: em `start()`, quando o updater roda, mostra a janela de abertura, espera `checkAtStartup` e só então cria a janela principal e o resto (o host, a bandeja, o controller). Com `'installing'`, não cria nada e deixa o `quitAndInstall` fechar o app.
- O intervalo de 6 h continua; a primeira verificação "10 s depois" deixa de existir quando houve a verificação de abertura.
- Nenhum dado novo sai do computador: é o mesmo pedido ao GitHub de hoje.

## 4. Testes

- **Unitários** (`updater.test.ts`, com o backend falso que já existe):
  - sem versão nova → `'continue'`;
  - erro e tempo esgotado → `'continue'`;
  - versão nova baixada → `'installing'` e `quitAndInstall(true, true)` chamado uma vez;
  - assinatura recusada → `'continue'`, estado `rejected`;
  - "Abrir sem atualizar" → `'continue'` e o download segue; quando termina, o estado vira `downloaded` e nada instala sozinho;
  - já baixada de antes → `'installing'` sem nova verificação;
  - desligado ou `unsupported` → `'continue'` na hora, sem janela.
- **Smoke:** o modo smoke continua sem janela de abertura.
- **Manual (checklist):** não há canal de teste de atualizações, então a prova real é o lançamento seguinte: com a 0.2.2 instalada, publicar a próxima versão, abrir o app e ver a janela de abertura baixar, instalar e reabrir.

## 5. Lançamento

Sai na **v0.2.2**, junto com a transmissão de tela e a foto de perfil. Quem está na 0.1.x, 0.2.0 ou 0.2.1 recebe a 0.2.2 pelo caminho de hoje (ao sair, ou com "Reiniciar para atualizar"). Da 0.2.2 em diante, cada abertura atualiza.
