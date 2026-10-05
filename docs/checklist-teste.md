# Checklist de teste manual (v0.1)

Roteiro da spec §14 para o que os testes automáticos não cobrem: redes reais, várias máquinas, o instalador e a atualização. Rode antes de cada release (em especial antes da `v0.1.0` e da `v0.1.1` de teste da atualização).

**Como usar:** copie esta lista para a issue ou o PR da release e marque cada item. Anote a versão, o Windows (10 ou 11) e a rede de cada teste. Um item só passa com o resultado esperado inteiro.

**Fora da v0.1** (não testar): câmera, compartilhamento de tela (incluindo "tela 1080p60 durante um jogo"), arquivos e imagens, avatares e o app para macOS (Mac real, Chaveiro, Gatekeeper).

## Preparação

- [ ] Três pessoas (A, B e C) em **três redes diferentes**, pelo menos uma em Wi-Fi doméstico e uma no 4G/5G roteado pelo celular.
- [ ] Uma VPS Ubuntu 22.04+ ou Debian 12+ com IP público e as portas 7700/TCP, 7882/UDP e 7881/TCP liberadas no firewall do provedor.
- [ ] Radmin VPN (ou Tailscale) instalado em duas das máquinas.
- [ ] Um jogo que rode em tela cheia (para o push-to-talk) e, se possível, um que rode como administrador.

## 1. Download e instalação

- [ ] **Site → Baixar:** o botão mostra a versão certa e o tamanho, e baixa `GhostLink-Setup-<versão>.exe` da tag certa.
- [ ] **Verificar downloads:** os comandos da página funcionam como estão escritos: `cosign verify-blob` (Verified OK), `sha256sum --ignore-missing -c` (OK), o `Get-FileHash` do PowerShell (True) e o `openssl pkeyutl -verify` (Signature Verified Successfully).
- [ ] **SmartScreen:** aparece "O Windows protegeu o computador"; **Mais informações → Executar assim mesmo** instala sem pedir administrador, em `%LOCALAPPDATA%\Programs\ghostlink`.
- [ ] O app abre com o **fantasma** no ícone da janela, da barra de tarefas e do instalador, e o selo **beta** aparece.
- [ ] O idioma segue o do Windows (pt-BR ou inglês) e dá para trocar nas configurações.

## 2. Identidade

- [ ] O onboarding diz que não há conta, pede apelido e oferece exportar o backup.
- [ ] **Exportar** gera um `.ghostkey` com senha. Em outra máquina (ou outro usuário do Windows), **Importar** com a senha certa recupera a mesma identidade: ela entra nos mesmos servidores como a mesma pessoa, com os mesmos cargos. Com a senha errada, falha sem estragar nada.
- [ ] Copiar a pasta `%APPDATA%\GhostLink` para outro usuário do Windows mostra "Não foi possível abrir sua identidade" e **nunca** cria uma identidade nova sozinho. **Criar identidade nova** exige confirmação dupla e guarda `identity.bin.bak-<data>`.

## 3. Hospedar no app, pela internet sem VPN

- [ ] A clica em **Hospedar um servidor**: o progresso mostra certificado, voz, UPnP e firewall, e A vira dono sozinho.
- [ ] O Windows pergunta pelo firewall do **GhostLink** e do **livekit-server.exe**. Recusando de propósito, **Corrigir firewall** (com UAC) resolve.
- [ ] Com UPnP no roteador: o painel mostra as portas abertas e o IP público. Sem UPnP: o painel mostra o passo a passo, e com o encaminhamento manual tudo funciona.
- [ ] Numa rede com **CGNAT**: o app avisa e sugere VPN ou VPS.
- [ ] Com a porta 7700 ocupada por outro programa: o app avisa e oferece 7710; o aviso diz que convites antigos param de funcionar.
- [ ] **Copiar convite** copia `https://gestao-in7eligente.github.io/ghostlink/j/#GL1-…`.
- [ ] B (sem o app) abre o link no Chrome ou no Edge: depois de ~1,5 s a página mostra o download e o código `GL1-`. B instala, cola o código em **Entrar num servidor** e entra.
- [ ] C (com o app) abre o mesmo link: o navegador pergunta se pode abrir o GhostLink e o app abre direto no convite.
- [ ] No Firefox, a página não sai do ar: **Abrir no GhostLink** funciona.
- [ ] Um link cortado ou alterado mostra "Este link de convite não funciona".
- [ ] Fechar a janela de A deixa o GhostLink na bandeja com o servidor no ar; **Sair** na bandeja derruba o servidor e o LiveKit (confira no Gerenciador de Tarefas).

## 4. Radmin VPN (ou Tailscale)

- [ ] Com a VPN ligada em A e B, o convite de A traz o IP da VPN (Radmin `26.x.x.x`, Tailscale `100.64.x.x`–`100.127.x.x`), e B entra e fala por ela mesmo com a internet de A atrás de CGNAT.

## 5. VPS

- [ ] Os comandos de [Hospedar numa VPS](../docs-site/hospedar-em-vps.md) funcionam como estão escritos: o `sha256sum` confere o `install.sh`, e `sudo bash install.sh` instala, confere o checksum e a assinatura Ed25519 do `.tgz` e imprime o código de setup, a impressão digital e um convite.
- [ ] Numa VPS só com IP privado, o script pergunta o IP público; `--node-ip` funciona.
- [ ] O dono entra pelo app com o convite e o código de setup e vira dono; o código não funciona uma segunda vez.
- [ ] `invite`, `status`, `setup-code` e `reset-owner` funcionam como o usuário `ghostlink`.
- [ ] Rodar o `install.sh` de novo atualiza e mantém os dados; reiniciar a VPS traz o serviço de volta sozinho.
- [ ] Voz pela VPS funciona numa rede que bloqueia UDP (usa 7881/TCP).

## 6. Texto, cargos e privacidade

- [ ] Mensagens, respostas, reações, edição, exclusão, menções e não lidas aparecem certas nas três máquinas; uma menção gera notificação do Windows, e clicar nela abre o canal.
- [ ] Markdown com tentativa de HTML/script aparece como texto.
- [ ] A cria um **canal privado** para um cargo que C não tem: C não vê o canal, nem as mensagens, nem quem digita nele, nem as respostas que citam mensagens dele, nem a voz dele.
- [ ] A **expulsa** C: C cai e **não volta** sem um convite novo. A **bane** C: nem com convite novo.
- [ ] Um convite com 1 uso funciona uma vez; um convite revogado ou expirado dá "Convite inválido".
- [ ] **Transferir a posse** para B (confirmação dupla) e **Recuperar a posse** no Hospedar funcionam.
- [ ] O mesmo usuário abrindo o app em outro computador derruba a sessão anterior.

## 7. Voz

- [ ] **Mais de 12 pessoas** na mesma sala por pelo menos 10 minutos, com o servidor em casa e depois na VPS: áudio estável, sem cortes longos; anote a banda de upload do host.
- [ ] Mutar, ensurdecer, indicador de fala, troca de microfone e de saída com a call rolando, volume por pessoa.
- [ ] Um moderador silencia e move alguém; a pessoa removida do servidor sai da voz e não volta.
- [ ] **Push-to-talk com o jogo em foco** (tela cheia): a tecla abre o microfone só enquanto está apertada. Com o jogo como administrador, o comportamento é o documentado em Solução de problemas.

## 8. Atualização automática (release de teste `v0.1.1`)

- [ ] Com a `v0.1.0` instalada e a `v0.1.1` publicada, o app baixa sozinho (ao abrir, ou em até 6 h) e mostra **"Nova versão 0.1.1 baixada — Reiniciar para atualizar"**.
- [ ] **Reiniciar para atualizar** instala e reabre na `0.1.1`, com a identidade, os servidores salvos e o servidor hospedado intactos. **Depois** instala ao fechar o app.
- [ ] Com **Procurar atualizações automaticamente** desligado, o app não consulta o GitHub (confira com o Monitor de Recursos ou um firewall).
- [ ] **Assinatura inválida:** numa release de teste num fork (ou trocando o `.ed25519` por outro), o app recusa, apaga o download e mostra "não passou na verificação de assinatura". Nada é instalado.

## 9. Site

- [ ] Todas as páginas abrem em pt-BR e em inglês, a busca encontra as páginas e os links internos funcionam.
- [ ] Com as ferramentas de desenvolvedor abertas (aba Rede) na página `/j/`, nenhuma requisição vai para fora de `gestao-in7eligente.github.io` antes de clicar em baixar (aí só `api.github.com`), e nenhuma leva o `#GL1-…`.

