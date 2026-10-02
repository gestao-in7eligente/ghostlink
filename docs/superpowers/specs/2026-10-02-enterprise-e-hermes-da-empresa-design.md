# GhostLink — Enterprise e o Hermes da empresa

Dono, 2026-10-02: "Quero que nosso GhostLink tenha duas modalidades de servidor. A normal, que vai ter o DJ, e a Enterprise." Decisões do dono:

- **Enterprise é a versão paga, com recursos exclusivos**, liberados por uma licença assinada por ele.
- **O recurso exclusivo é um Hermes próprio da empresa.**
  - É um serviço separado do Hermes Trismegisto, só no GhostLink, sem Discord, com skills feitas para aquela empresa.
  - Há **um por empresa**.
  - O projeto da empresa no Railway tem **os dois serviços**: o servidor GhostLink e o Hermes.
- **O Hermes de cada empresa nós criamos juntos**, pelo Railway CLI. Não há criação automática pelo app.
- **Ele começa só com as skills genéricas do Trismegisto**, revisadas, sem memória, conversas nem chaves.
- **As chaves de IA são da própria empresa** e aparecem nas configurações do bot do Hermes.
- **As configurações do Hermes** são chaves de IA, modelos, skills, quem pode usar e memória.
- **O caminho das configurações é a conexão do bot (caminho A):** o servidor guarda e envia ao Hermes, e o plugin aplica.
- **O Enterprise não tem o Ghost DJ.**
- **A licença é assinada e tem validade.**

Exemplos: **TC Flag** é o primeiro Enterprise (o Hermes dele é o **TC Hermes**). **Tropa do Ads** é normal e tem o DJ.

## 1. Licença e modalidade

- **Chave de licenças:**
  - É uma chave Ed25519 nova, só para licenças, separada da chave das versões. É gerada uma vez por `scripts/gen-license-key.mjs`.
  - A chave privada fica no PC do dono, em `D:\GhostLink Licencas\`, com uma cópia de segurança que o dono guarda onde escolher. Ela nunca entra no repositório.
  - A chave pública fica em `packages/shared` (servidor e app).
- **A licença:**
  - É um texto `GLE1.<dados>.<assinatura>` (base64url). Os dados são a versão, o nome da empresa, a identidade do servidor (o `serverKeyId`, o mesmo do convite), a data de emissão e a validade.
  - Copiada para outro servidor, não vale.
  - É emitida por `scripts/issue-license.mjs`, no PC do dono, junto com o Claude.
- **Onde fica:**
  - O dono do servidor cola a licença em **Configurações do servidor → Enterprise**, que só ele vê.
  - O servidor guarda a licença no banco e a confere ao colar, ao iniciar e a cada hora.
  - Trocar a licença (renovar) vale na hora, sem reiniciar o servidor.
- **Modalidade:**
  - O servidor é Enterprise enquanto a licença for válida para ele e a data estiver dentro da validade mais 7 dias.
  - Todo mundo recebe a modalidade (`edition: normal | enterprise`) e vê o selo **Enterprise** ao lado do nome do servidor.
  - Só o dono recebe os detalhes da licença (empresa e validade).
  - Um app antigo ignora a modalidade (função `enterprise` em `features`).
- **Sem DJ no Enterprise:**
  - O Ghost DJ some da lista de membros e não atende comandos. Se estiver tocando quando o servidor vira Enterprise, ele para e sai da chamada.
  - O equalizador, o volume e o arquivo de cookies ficam guardados.
- **Validade:**
  - O dono vê um aviso nos 7 dias antes de vencer e nos 7 dias depois.
  - Passado esse prazo, o servidor volta a ser normal:
    - o Hermes da empresa é desconectado e recusado ao tentar entrar, com o erro `enterprise_required`;
    - as configurações dele ficam guardadas, mas travadas;
    - o DJ volta.

## 2. O Hermes da empresa no GhostLink

- **Criar:**
  - Num servidor Enterprise, "Adicionar Bots" ganha a opção **Hermes da empresa**. Só o dono vê, e só existe um por servidor; o banco marca esse bot como o Hermes da empresa.
  - A opção gera um código de conexão como qualquer bot, e o código vai para a variável `GHOSTLINK_BOT` do serviço do Hermes no Railway.
  - **Só esse bot recebe as configurações.** Um bot comum que diga ser o Hermes não recebe nada.
- **Configurações** (botão direito → Configurações): as abas atuais continuam e ganham cinco novas, que só o dono vê e altera.
  - **Chaves de IA:**
    - A DeepSeek e a OpenRouter. O dono cola a chave e salva.
    - Depois a tela mostra só "configurada (final 1234)", com trocar e apagar. A chave nunca volta para o app e nunca vai para os logs.
    - O servidor guarda a chave no banco, junto dos outros segredos dele, e ela é apagada se o servidor for excluído.
  - **Modelos:** o principal e o reserva, entre os provedores que têm chave. Hoje o padrão é DeepSeek `deepseek-v4-pro`, com reserva OpenRouter `deepseek/deepseek-v4-pro`.
  - **Skills:** a lista com nome e descrição, com liga/desliga.
  - **Quem pode usar:**
    - Os cargos que podem falar com ele; o dono sempre pode.
    - Os canais onde ele responde: todos ou os escolhidos.
    - Ele continua respondendo só quando alguém o menciona ou responde a ele.
  - **Memória:** os itens que ele guardou, sobre a empresa e sobre as pessoas, com apagar item por item.
- **Situação:** se ele está conectado, o modelo em uso e o último erro de chave (ex.: "A DeepSeek recusou a chave").
- **Hermes desconectado:**
  - O que o dono mudar fica guardado e é aplicado quando ele reconectar.
  - Skills e memória mostram a última lista recebida, com o aviso "Hermes desconectado".
- **Custo:** mudar configurações e ver skills ou memória não passa pela IA, então não gasta tokens. Apagar memória inútil e desligar skills deixa cada conversa mais barata.
- **Protocolo** (função `enterpriseHermes`):
  - **Pedidos do dono:** `hermes.get`, `hermes.update` e `hermes.memory.delete`.
  - **Evento para o bot do Hermes da empresa:** `hermes.config`, com a configuração desejada inteira, chaves incluídas. Vai ao conectar e a cada mudança, só pela conexão TLS fixada do bot.
  - **Pedido do bot:** `hermes.report`, com skills, memória e situação.
  - **Evento para os apps do dono:** `hermes.state`, que atualiza o painel aberto ao vivo.

## 3. O lado do Hermes (plugin GhostLink)

- **Aplicar `hermes.config`:**
  - **Onde grava:**
    - as chaves no `.env` do `$HERMES_HOME`, mexendo só nas variáveis que o plugin controla;
    - os modelos em `model` e `fallback_model` do `config.yaml`;
    - as skills pelo mecanismo do próprio Hermes, que será confirmado no plano;
    - cargos e canais na configuração do próprio plugin.
  - **Backup:** antes de gravar, guarda uma cópia de cada arquivo (as 5 últimas).
  - **Reinício:** quando chaves ou modelos mudam, reinicia o gateway pelo s6, o que leva alguns segundos.
- **Testar as chaves:** cada chave nova é testada na lista de modelos do provedor, que não gasta tokens. O resultado vai na situação.
- **Informar (`hermes.report`):**
  - as skills, lidas dos `SKILL.md`;
  - a memória, lida de `memories/MEMORY.md` e `USER.md`, item a item;
  - a situação.
  - O plugin manda ao conectar e quando algo muda.
- **Apagar memória:** remove o item pedido do arquivo e manda a lista nova.
- **Versão fixa:** a imagem do Hermes é fixada pelo digest. Se o formato dos arquivos não for o esperado, o plugin não aplica nada e informa "versão do Hermes não suportada".

## 4. Criar o TC Hermes (operação, com o dono)

1. **Serviço:** "TC Hermes" no projeto Railway **ghostlink-tc-flag**.
   - Usa a mesma imagem fixada do Trismegisto, com volume `/data` e 2 vCPU / 2 GB.
   - Fica sem domínio público.
2. **Só GhostLink:**
   - O plugin GhostLink vem do repositório, na versão do app, com `plugins.enabled: [ghostlink]`.
   - Discord e as outras plataformas ficam desligados, e a API do Hermes fica sem acesso de fora.
   - O comando de início mantém o patch #15 (com a mesma proteção de versão) e não tem o patch do Discord.
3. **Skills genéricas:**
   - O Claude classifica as 46 skills ativas do Trismegisto em genéricas e específicas da Macrol.
   - **O dono aprova a lista** antes da cópia.
   - Skills com chave, token ou endereço interno são limpas ou ficam de fora.
4. **Começa limpo:** sem memória, conversas nem chaves. A personalidade ("TC Hermes, assistente da TC Flag") é escrita com o dono.
5. **Ativação:**
   - O dono cola a licença no TC Flag e cria o "Hermes da empresa".
   - O código de conexão vai para `GHOSTLINK_BOT` no TC Hermes.
   - A TC Flag cola as próprias chaves nas configurações do bot.

## 5. Versões

- **v0.5.2 (antes, pequena):** só tem coisas do Ghost DJ e não faz parte deste desenho.
  - o botão "Enviar cookies do YouTube" no painel do DJ, só para o dono;
  - a cópia dupla dos pacotes de som desligada (por TCP ela só dobra o tráfego).
- **v0.6.0:**
  - as seções 1 a 3 deste desenho;
  - depois de publicada, a seção 4.

## 6. Testes (enxutos)

- **Licença:** válida, vencida dentro e fora dos 7 dias, de outro servidor, falsificada e com formato quebrado.
- **DJ:** some no Enterprise e volta quando o servidor deixa de ser.
- **Chaves:** nunca voltam ao app e só vão para o bot marcado como Hermes da empresa. Outro bot e um servidor normal não recebem.
- **Plugin (Python, numa pasta de teste do Hermes):** aplica chaves, modelos, skills e acesso, guarda o backup, recusa formato desconhecido e apaga um item da memória.
- **Ponta a ponta:** o dono muda o modelo no app, a configuração chega a um Hermes de teste e o painel mostra a situação nova.

## Fora deste desenho

- criar o Hermes da empresa automaticamente pelo app;
- cobrança e pagamento;
- mais de um Hermes por servidor;
- Enterprise em servidor hospedado no próprio app (Windows);
- o app Android.
