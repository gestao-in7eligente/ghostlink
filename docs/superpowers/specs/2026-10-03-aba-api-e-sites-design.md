# GhostLink: a aba API e a categoria Sites (v0.7.0)

Pedidos do dono em 2026-10-03:
- "Deve ter a aba de API para cadastrar as API das IA e outras que possam ter futuramente."
- "Abaixo da categoria Bots, deve ter a categoria Sites, onde vão ser cadastrados sites que o Hermes vai mandar as informações das ações que ele faz no site, nos canais de texto dos respectivos sites."

Escolhas do dono:
- **Aba API:** fica na página do Hermes e só o dono a vê. Ela substitui a aba "Chaves de IA" das Configurações e tem um **catálogo mais "Outra API"**.
- **Site:** o cadastro tem **nome, endereço e canal**. Os canais que já existem com nome de site **viram os sites**.
- **Quem mexe nos sites:** **o dono e o cargo da página**.
- **O que o Hermes posta:** **cada ação**, **erros e bloqueios**, e um **resumo do dia**.
- **Skills de sites no TC Hermes:** copiar as 3 skills, com as chaves vindo da aba API.

Lançamento: a v0.6.3 (página larga e abas) sai antes, e este desenho vem na v0.7.0, com o plugin 1.2.

Regras que continuam valendo:
- O repositório é público: nenhuma chave em arquivo do projeto.
- As chaves ficam no banco do servidor GhostLink. Não voltam ao app (só os 4 últimos caracteres), não vão para logs e, no Hermes, vivem só na memória do processo.
- O plugin só aceita configuração de empresa com `GHOSTLINK_COMPANY=true`.

## 1. Aba API (página do Hermes da empresa, só o dono)

- **Uma aba nova, "API"**, na página do Hermes da v0.6.3, visível só para o dono. A aba "Chaves de IA" sai das Configurações. As chaves de DeepSeek e OpenRouter que já existem continuam valendo e aparecem na aba API.
- **Catálogo**, com cada API e a sua variável:
  - **IA:** DeepSeek (`DEEPSEEK_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`), OpenAI (`OPENAI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`) e Google Gemini (`GEMINI_API_KEY`). Os nomes exatos são os que o Hermes lê, a confirmar no plano.
  - **Outras:** ElevenLabs (`ELEVENLABS_API_KEY`), Grok/xAI (`GROK_API_KEY`), Yunwu (`YUNWU_API_KEY`) e o MCP do Macrol Dashboard (`MACROL_MCP_KEY`).
- **Outra API:**
  - **Nome:** um nome de exibição e o nome da variável, em maiúsculas, com números e `_`, de 3 a 64 caracteres.
  - **Nomes recusados:**
    - os do sistema (`PATH`, `HOME`, `LD_*`, `PYTHON*`, `NODE_*`, `SSL_*`, `HTTP(S)_PROXY`…);
    - os do Hermes e do GhostLink (`HERMES_*`, `GHOSTLINK_*`);
    - os que já estão no catálogo.
  - **Limite:** até 30 chaves no total.
- **Cada linha mostra:**
  - o nome, a variável e "configurada (final 1234)" ou "não configurada";
  - os botões **Trocar** e **Apagar**;
  - para as IAs, o resultado do teste da chave, que não gasta tokens: "ok" ou "recusada". As outras APIs não são testadas.
- **Modelos:** as IAs do catálogo que tiverem chave aparecem como provedores na aba Modelos, para o principal e o reserva. A lista de provedores segue o que o Hermes aceita.
- **No Hermes:** o plugin 1.2 põe cada chave no ambiente do processo e tira a que for apagada. As chaves de IA ficam escondidas dos comandos de terminal, pela proteção do próprio Hermes. As outras ficam visíveis para os scripts das skills.

## 2. Categoria Sites (só em servidor Enterprise)

- **Na barra lateral:** uma categoria **SITES** logo abaixo de **BOTS**. Cada site aparece com um ícone de globo e o nome. Clicar abre o canal de texto do site, como qualquer canal.
- **Cadastrar** (botão + da categoria, só para o dono e o cargo da página):
  - **Nome:** ex. "Profeta Cristão ES".
  - **Endereço:** um domínio, ex. `es.profetacristao.com`, sem caminho e sem segredo.
  - **Canal:** escolher um canal de texto existente ou "Criar canal novo", que ganha o nome do endereço. Um canal existente sai da sua categoria e vai para Sites com todo o histórico.
- **Editar** e **Remover**: pelo botão direito no site. Remover tira o site da categoria. O canal continua existindo e volta para "Canais de texto"; nada é apagado.
- **Permissões do canal:** iguais às de um canal comum. Quem não vê o canal não vê o site.
- **Limite:** até 50 sites.
- **Para o Hermes:** o servidor envia a lista de sites (nome, endereço e canal) no `hermes.config`, sem chaves. Com essa lista, o Hermes:
  - **posta cada ação feita** num site, um resumo curto (o que fez e o link), no canal do site;
  - **posta erros e bloqueios** do site no mesmo canal;
  - **posta um resumo do dia** de cada site com atividade, no fim do dia (23h, horário de São Paulo), pelo agendador do próprio Hermes. Um site sem atividade não gera mensagem.
- **Como o Hermes faz isso:**
  - O plugin entrega a lista e as instruções ao Hermes como uma skill gerada, "ghostlink-sites", sem segredo.
  - Ele também oferece o jeito de postar no canal certo: a ferramenta de envio do próprio Hermes ou uma ferramenta do plugin, a confirmar no plano.
  - O resumo do dia é um agendamento do Hermes que o plugin cria e mantém.

## 3. Skills de sites no TC Hermes (operação, depois da v0.7.0)

- **Copiar do Trismegisto** `macrol-sites-dashboard`, `macrol-dashboard-mcp` e `wp-set-user-avatars`. Cada chave escrita nos arquivos é trocada por leitura da variável correspondente, sem que os valores sejam lidos ou mostrados. O que não der para limpar com segurança fica de fora, e o dono é avisado.
- **O MCP do Macrol Dashboard** entra na configuração do TC Hermes com o cabeçalho de acesso lendo `MACROL_MCP_KEY` do ambiente.
- **Um ponto a confirmar no código do Hermes:** ele conecta o MCP quando liga.
  - Se ele conseguir reconectar o MCP depois que a chave chega pelo GhostLink, ela vem da aba API.
  - Se não conseguir, **essa chave específica** fica numa variável do Railway do TC Hermes, que a regra do dono permite.
- **Quem cadastra as chaves:** o dono põe na aba API as chaves do MCP do Macrol Dashboard, da Grok e da Yunwu.

## 4. Protocolo e versões

- **Funções novas:** `enterpriseApis` (a aba API) e `enterpriseSites` (a categoria Sites). Apps e servidores antigos ignoram as duas.
- **Plugin 1.2:** aceita as chaves genéricas e a lista de sites no `hermes.config` e mantém a skill gerada e o agendamento do resumo. Ele continua aceitando a configuração da 1.1. A instalação no TC Hermes é feita pelo Claude, com o hash conferido contra a tag.

## 5. Testes (enxutos)

- **Servidor:**
  - só o dono cadastra e apaga chaves;
  - nomes de variável proibidos são recusados;
  - as chaves nunca voltam ao app;
  - só o dono e o cargo da página cadastram sites;
  - mover o canal para Sites mantém o histórico, e remover o site devolve o canal;
  - o `hermes.config` leva os sites e as chaves só para o Hermes da empresa.
- **Plugin:**
  - põe e tira as variáveis no ambiente, sem gravar em disco;
  - gera a skill de sites sem segredo;
  - cria e atualiza o agendamento.
- **App:**
  - os auxiliares puros da aba API (catálogo, validação do nome) e dos sites;
  - o i18n completo.
- **Ponta a ponta:** o teste da v0.6.0 ganha uma chave genérica e um site.
