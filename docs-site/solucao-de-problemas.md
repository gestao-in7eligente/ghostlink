---
title: Solução de problemas
description: Soluções para os problemas mais comuns do GhostLink.
---

# Solução de problemas

## Instalar e abrir

### O Windows não deixa instalar

É o SmartScreen, porque o instalador ainda não tem assinatura de código paga. Clique em **Mais informações → Executar assim mesmo**. Para ter certeza de que o arquivo é o oficial, [verifique o download](./verificar-downloads).

### "Não foi possível abrir sua identidade"

O Windows não conseguiu decifrar a chave guardada. Acontece, por exemplo, depois que um administrador redefine a sua senha do Windows ou quando a pasta do app é copiada de outro computador. O app **nunca** cria uma identidade nova sozinho nesse caso. Você pode:

- **Tentar de novo**;
- **Importar backup** (o arquivo `.ghostkey`);
- **Criar identidade nova**, com confirmação dupla. O arquivo antigo é guardado com o nome `identity.bin.bak-<data>`, e você volta aos servidores como outra pessoa.

## Convites e conexão

### O link de convite abre o navegador, mas não o app

- Se o navegador perguntar se pode abrir o GhostLink, permita.
- No Firefox, clique em **Abrir no GhostLink**.
- Se não funcionar, copie o código `GL1-…` que a página mostra e cole no app, em **Entrar num servidor**.

### "Convite inválido"

O convite expirou, atingiu o limite de usos ou foi revogado. Também acontece quando o link chega cortado: copie o link inteiro. Peça um convite novo.

### "A chave do servidor mudou"

O servidor que respondeu nesse endereço não é o mesmo de antes. Pode ser um servidor falso. Não continue sem confirmar com o dono. Se o dono reinstalou o servidor do zero, ele precisa mandar um convite novo.

### Ninguém consegue entrar no meu servidor (Hospedar)

Siga nesta ordem:

1. **Firewall do Windows:** no painel do Hospedar, use **Corrigir firewall**.
2. **UPnP:** se o painel disser que não conseguiu abrir as portas, abra à mão no roteador: 7700/TCP, 7882/UDP e 7881/TCP para o IP do seu computador. Veja [Hospedar no app](./hospedar-no-app#upnp-abrir-portas-sozinho).
3. **CGNAT:** se o app avisar de CGNAT, ninguém de fora alcança o seu computador. Use uma VPN (Radmin VPN, Tailscale, ZeroTier) ou uma [VPS](./hospedar-em-vps).
4. **Teste de fora:** teste com o celular no 4G/5G (fora do Wi-Fi de casa), abrindo o convite em outro computador.

### "A porta já está em uso"

Outro programa já usa a porta 7700. Aceite a próxima porta livre que o app oferece. Os convites antigos deixam de funcionar: mande um novo.

## Voz

### Entro na sala de voz, mas não ouço ninguém ou ninguém me ouve

- Confira os dispositivos de entrada e saída no painel de voz.
- No Windows: **Configurações → Privacidade e segurança → Microfone**, ligue **Permitir que aplicativos da área de trabalho acessem o microfone**.
- Se você hospeda: o Windows precisa permitir o **livekit-server.exe** no firewall (use **Corrigir firewall**), e a porta **7882/UDP** precisa estar aberta. Em redes que bloqueiam UDP, a voz usa a **7881/TCP**.

### O push-to-talk não funciona dentro do jogo

Se o jogo roda **como administrador**, o Windows não deixa outros programas lerem as teclas enquanto ele está em foco. Abra o jogo sem ser administrador (ou, em último caso, o GhostLink também como administrador).

## Atualizações

### "A versão X não passou na verificação de assinatura"

O app baixou uma atualização que não tinha a assinatura da chave de release do GhostLink. Ela foi apagada e **nada foi instalado**. Baixe o GhostLink só pelo [site](./download) ou pela página de releases no GitHub e, se o aviso continuar, [relate o problema](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new).

### O app não se atualiza

A atualização automática só existe no app instalado no Windows. Confira se **Procurar atualizações automaticamente** está ligado em **Atualizações**, nas configurações. Você sempre pode baixar a última versão [aqui](./download) e instalar por cima.

## Registro de erros (log)

O app grava um log em `%APPDATA%\GhostLink\logs\main.log`. Ele ajuda a entender um problema. Senhas, convites e chaves não vão para o log, mas confira o conteúdo antes de mandar para alguém.
