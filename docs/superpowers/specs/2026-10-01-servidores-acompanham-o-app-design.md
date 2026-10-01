# GhostLink — Servidores acompanham a versão do app

Desenho aprovado pelo dono em 2026-10-01 ("Todos os servidores devem acompanhar a versão do nosso app. Para não haver divergências"). Muda a spec principal §15 (atualizações) e a §9.1 (Railway no app).

## 1. Decisões

| Tipo de servidor | Como acompanha |
|---|---|
| **Hospedado no app** | Já acompanha: usa o servidor que vem dentro do app. Nada muda. |
| **Railway criado pelo app** (registro `managed` em `railway.json`) | O **app do dono** atualiza: troca a imagem do serviço para a versão do app e publica de novo. |
| **VPS** (`install.sh`) | O **próprio servidor** se atualiza: um atualizador instalado pelo `install.sh` baixa, confere e troca a versão. |
| **Docker por conta própria / Railway criado à mão** | O app não tem acesso. A imagem ganha a tag móvel `latest` e a documentação explica como acompanhar (por exemplo com Watchtower). |

**Quando reinicia:** só **sem ninguém em canal de voz**. Se em **24 h** desde que a versão nova ficou disponível não houver um momento assim, atualiza mesmo assim. Quem está conectado no chat reconecta sozinho.

**Lançamento:** na **v0.2.2**.

## 2. O servidor informa se está ocioso

Os dois caminhos precisam saber se há alguém em chamada, sem expor isso a qualquer um.

- **Arquivo local (VPS):** o servidor grava `<dataDir>/status.json` (`0640`, dono o usuário do serviço) com `{ "version", "voiceActive": boolean, "updatedAt" }`. Grava ao iniciar, a cada mudança de `voiceActive` e a cada 60 s. Atômico (temp + rename).
- **Consulta do dono (Railway):** `GET /owner/status?ts=<unix>&sig=<base64url>`:
  - `sig` = assinatura Ed25519, com a **chave do dono para este servidor** (a mesma identidade por servidor que o app usa para entrar), sobre `ghostlink-owner-status-v1\n<serverKeyId>\n<ts>`;
  - o servidor confere com a chave pública do dono atual (`ownerId`), `ts` a no máximo 60 s do relógio dele;
  - responde `200 { version, voiceActive }`, ou `403` (assinatura, dono ou tempo errados); `nosniff`, `no-store`;
  - limite de 30 pedidos por minuto por endereço;
  - não registra a URL.
- `/health` continua sem dado sensível (já tem `version`).

## 3. Railway: o app do dono atualiza

- **Quando checa:** depois da atualização ao abrir (o app já está na versão nova) e a cada 30 min enquanto aberto, para cada servidor em `managed`, se o token do Railway estiver conectado.
- **Passos para cada servidor:**
  1. `GET /health` (com o certificado fixado pelo `serverKeyId` do registro): se `version` é igual ou mais nova que a do app, nada a fazer.
  2. Se é mais antiga: grava `outdatedSince` no registro (se ainda não tiver).
  3. Consulta `/owner/status`. Com `voiceActive: false`, **ou** `outdatedSince` há mais de 24 h, atualiza; senão tenta de novo em 10 min.
  4. Atualizar = `serviceInstanceUpdate` com `source.image = ghcr.io/gestao-in7eligente/ghostlink-server:<versão do app>` e um novo deploy do serviço (a mesma operação que o provisionamento usa). O volume e as variáveis ficam.
  5. Espera o deploy ficar `SUCCESS` (até 10 min, como no provisionamento) e confere `/health` com a versão nova; limpa `outdatedSince`.
- **Falhas:** registradas no log sem token nem URL; tenta de novo no ciclo seguinte. Token desconectado ou recusado: o aviso do §5 pede para conectar o Railway de novo.
- O app só atualiza para a **própria versão** (nunca para outra), e só servidores do próprio registro `managed`.

## 4. VPS: o servidor se atualiza

- O `install.sh` passa a instalar:
  - uma cópia dele mesmo em `/opt/ghostlink/install.sh`;
  - `ghostlink-update.service` (root, `Type=oneshot`) que roda `/opt/ghostlink/install.sh --auto-update`;
  - `ghostlink-update.timer` a cada hora (com `RandomizedDelaySec`).
  - Uma opção `--no-auto-update` deixa o timer de fora (e `--auto-update off` o remove de um servidor já instalado).
- `--auto-update`:
  1. Busca a release mais recente no GitHub.
  2. Se é mais nova que `current`: baixa e **confere como o `install.sh` já faz** (checksums assinados, Ed25519 da release); prepara `releases/<versão>` **sem trocar** `current`. Grava `/var/lib/ghostlink/update-pending` com a versão e a hora.
  3. Lê `status.json`: se `voiceActive` é `false` e o arquivo tem menos de 3 min, **ou** a versão está pendente há mais de 24 h: troca `current`, reinicia `ghostlink.service`, apaga o pendente.
  4. Senão, sai; o timer tenta de novo.
- O LiveKit também é atualizado quando a release pede outra versão (a mesma lógica do `install.sh`).

## 5. Aviso para o dono

- Conectado a um servidor do qual é dono, com versão mais antiga que o app: uma faixa no topo do chat, só para o dono:
  - **Railway gerenciado:** "Este servidor está na 0.2.0. Ele será atualizado para a 0.2.2 quando ninguém estiver em chamada." + **Atualizar agora** (pula a espera de ociosidade, com confirmação: "Quem estiver em chamada cai por alguns segundos").
  - **Outros:** "Este servidor está na 0.2.0. Atualize para a 0.2.2 (veja como)" com o link da documentação.
- Membros que não são donos não veem nada.

## 6. Testes

- **Servidor:**
  - `status.json` (conteúdo, atualização ao mudar a voz);
  - `/owner/status`: assinatura válida, de outro usuário, de outro servidor (outro `serverKeyId` no texto), `ts` velho ou futuro, limite.
- **App:**
  - a decisão de atualizar (mesma versão, mais antiga e ocioso, mais antiga e em chamada, 24 h passadas, token ausente) com fakes;
  - as chamadas ao Railway com o cliente falso que o provisionamento já usa;
  - a faixa do dono (gerenciado ou não, membro comum não vê).
- **`install.sh`:**
  - `--auto-update` em modo `DRY_RUN` (o teste existente do script): sem versão nova não faz nada; com versão nova e ocioso troca `current`; em chamada só prepara; pendente há mais de 24 h troca.
  - O timer e o service gerados.
- **Release:** a imagem ganha a tag `latest` (o teste do workflow).
