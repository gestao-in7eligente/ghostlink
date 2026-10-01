---
title: Privacidade e segurança
description: O que o GhostLink protege, o que não protege e em quem você precisa confiar.
---

# Privacidade e segurança

Esta página diz, sem rodeios, o que o GhostLink protege e o que ele **não** protege.

## O que o GhostLink protege

- **Sem conta e sem servidor central.** Não existe cadastro, e-mail nem telefone. Sua identidade é uma chave criada no seu computador e guardada cifrada pelo Windows. O app nunca a envia a ninguém: ele só assina um desafio para provar que é você.
- **Uma identidade por servidor.** Cada servidor recebe uma chave derivada diferente. Dois servidores não conseguem saber que são a mesma pessoa, e um servidor não consegue se passar por você em outro.
- **Tráfego criptografado.** Tudo entre o app e o servidor passa por TLS, e o áudio da voz também é criptografado no caminho.
- **Servidor certo.** O app fixa a chave do servidor (a impressão digital que vem no convite). Se alguém no caminho tentar se passar pelo servidor, a conexão é recusada. Se a chave de um servidor salvo mudar, o app bloqueia e avisa.
- **Permissões no servidor.** Canais privados, cargos, expulsões e banimentos são aplicados pelo servidor. Um canal privado não aparece nem chega de nenhuma forma para quem não tem acesso.
- **Mensagens diretas sem servidor no meio.** Entre amigos, as mensagens vão direto de um computador para o outro, criptografadas de ponta a ponta. Nenhum servidor guarda ou lê essas conversas.
- **Sem telemetria.** O servidor não fala com terceiros. O app fala com terceiros só em dois casos: a procura de atualizações no GitHub, que você pode desligar, e a rede de amigos, enquanto "Ficar disponível para amigos" estiver ligado (o padrão). Nela, o app usa a DHT pública do Hyperswarm para achar seus amigos e conecta direto nos computadores deles.

## O que o GhostLink não protege

::: warning Quem hospeda vê tudo o que passa pelo servidor
Nos servidores não há criptografia ponta a ponta. **Quem hospeda o servidor consegue ler as mensagens, ouvir o áudio e ver o IP de todos que se conectam.** As mensagens ficam guardadas no servidor. Só entre em servidores de quem você confia.
:::

- **Hospedar expõe o seu IP** a todos que têm o convite, porque o endereço vai dentro dele. Se isso incomoda, hospede numa [VPS](./hospedar-em-vps). Os outros membros não veem o IP uns dos outros: tudo passa pelo servidor.
- **Amigos veem o seu IP.** A rede de amigos é direta: seus amigos, e quem tem o seu código de amigo enquanto você está online, veem o seu IP. Os nós da DHT pública que guardam o seu anúncio veem a sua chave de amigo e o seu IP, mas não as mensagens. Para sair da rede, desligue "Ficar disponível para amigos" (em Amigos → Adicionar amigo). Para cortar quem tem um código antigo, gere um código novo.
- **Convites dão acesso.** Quem tiver um link de convite válido entra no servidor. Mande convites só para quem deve entrar, prefira convites com limite de usos e validade e revogue os que vazarem.
- **A atualização automática confia no GitHub, no CI e na chave de release.** O app só instala uma versão assinada pela chave de release do GhostLink, que fica num ambiente protegido do GitHub e só é usada depois de aprovação manual. Se essa chave, a conta do projeto ou o GitHub forem comprometidos, uma versão maliciosa poderia chegar. Para não depender disso, desligue a atualização automática e [verifique cada download](./verificar-downloads).
- **Os números das mensagens revelam o volume.** O ID de cada mensagem é crescente e único no servidor todo. Pelos saltos entre os IDs, qualquer membro consegue estimar quantas mensagens foram enviadas no total, inclusive em canais que não vê. O conteúdo e o canal dessas mensagens continuam escondidos.
- **O seu computador.** Quem usa a sua conta do Windows consegue abrir o GhostLink como você. O backup `.ghostkey` é tão sensível quanto a identidade: proteja com uma senha forte.

## Este site

O site não usa cookies, trackers nem fontes ou scripts de terceiros. Os botões de download consultam a API do GitHub a partir do seu navegador para achar a versão mais recente. Na página de convite (`/j/`), o convite fica depois do `#` do link: essa parte **nunca é enviada** a nenhum servidor, nem a este site. A página só lê o convite no navegador e o entrega ao app.

## Relatar uma falha de segurança

Não abra uma issue pública. Use o [relatório privado de vulnerabilidades do GitHub](https://github.com/gestao-in7eligente/ghostlink/security/advisories/new).
