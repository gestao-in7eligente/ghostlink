# GhostLink para o Hermes Agent

Plugin de plataforma que coloca o [Hermes Agent](https://github.com/NousResearch/hermes-agent) num servidor GhostLink como bot, ao lado das plataformas que ele já usa (Discord, Telegram…). Não mexe no código do Hermes: é um plugin de usuário.

## Instalar

1. No app do GhostLink, no servidor, crie o bot em **BOTS > + Adicionar bot** e copie o código de conexão (`ghostlink-bot://…`). Ele aparece uma vez só.
2. Copie a pasta `ghostlink/` para `$HERMES_HOME/plugins/ghostlink/`.
3. No `config.yaml` do Hermes, ative o plugin:
   ```yaml
   plugins:
     enabled:
       - ghostlink
   ```
4. Coloque o código na variável `GHOSTLINK_BOT` e reinicie o gateway (`hermes gateway run`).

Precisa de `aiohttp` e `cryptography`, que a imagem do Hermes já traz.

## Quem fala com o Hermes

O Hermes tem terminal e ferramentas, então só responde a quem estiver liberado:

| Variável | Para quê |
|---|---|
| `GHOSTLINK_ALLOW_OWNER` | o dono do servidor (padrão `true`) |
| `GHOSTLINK_ALLOWED_ROLES` | cargos, por nome ou id, separados por vírgula |
| `GHOSTLINK_ALLOWED_USERS` | ids de usuário do GhostLink (32 hex) |
| `GHOSTLINK_ALLOW_ALL_USERS` | qualquer membro (não recomendado) |

Quem não estiver liberado é ignorado pelo Hermes, como no Discord.

## Onde ele responde

| Variável | Para quê |
|---|---|
| `GHOSTLINK_REQUIRE_MENTION` | só quando mencionado (`@Hermes`) ou respondido (padrão `true`) |
| `GHOSTLINK_FREE_RESPONSE_CHANNELS` | canais onde não precisa mencionar |
| `GHOSTLINK_ALLOWED_CHANNELS` | se definido, os únicos canais que ele escuta |
| `GHOSTLINK_HOME_CHANNEL` | canal das tarefas agendadas e avisos |

Comandos do Hermes vão com menção: `@Hermes /new`.

## Segurança

A conexão é TLS presa à chave do servidor (o `pin` do código): se a chave não bater, nada é enviado, nem o token. O código de conexão é um segredo: guarde só na variável.

## Hermes da empresa (servidor Enterprise)

**Só vale se quem opera o Hermes ligar `GHOSTLINK_COMPANY=true`.** Sem isso o plugin ignora todo evento `hermes.*` e nunca manda `hermes.report`: nenhum servidor consegue mexer nas chaves, no `config.yaml`, nas regras de acesso, nos sites nem ler a memória desse Hermes.

Num servidor GhostLink Enterprise, o bot marcado como "Hermes da empresa" recebe do GhostLink, a cada conexão, as configurações que o dono mexe nas configurações do bot. O plugin aplica assim:

| O que o GhostLink manda | Onde o plugin grava |
|---|---|
| Chaves de API (aba API da página do Hermes: DeepSeek, OpenRouter, OpenAI, Anthropic, Google Gemini, ElevenLabs, Grok, Yunwu e as do dono) | Só na memória do processo do gateway, cada uma na sua variável (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `GROK_API_KEY`, `YUNWU_API_KEY`, `MINHA_API_KEY`…). Nunca em arquivo, nunca em log, nunca no relatório. O GhostLink manda de novo a cada conexão, e a chave apagada lá sai do processo. As de IA e a da ElevenLabs o próprio Hermes esconde dos comandos de terminal; as outras os scripts das skills leem. Uma variável que já estava no ambiente quando o gateway ligou (variável do Railway) nunca some: a chave de IA do GhostLink vale no lugar dela enquanto existir e, apagada no GhostLink, o valor do Railway volta; uma chave de "Outra API" nunca a troca. |
| Modelo principal e reserva | `config.yaml`: `model.provider` e `model.default`; a reserva em `fallback_providers` (ou em `fallback_model`, se o arquivo usa o formato antigo). |
| Skills ligadas e desligadas | `config.yaml`: `skills.disabled` (a skill `hermes-agent` nunca é desligada). |
| Cargos e canais com acesso | Só na memória do plugin. O dono sempre pode falar com o Hermes; nos canais liberados ele responde só quando mencionado ou quando respondem a ele. |
| Apagar um item da memória | `memories/MEMORY.md` e `USER.md`, com o mesmo bloqueio que o Hermes usa. |
| Sites | A skill `skills/ghostlink/ghostlink-sites/SKILL.md` (gerada, sem segredo; some com o último site), as ferramentas `ghostlink_site_post` e `ghostlink_site_activity` (só aparecem com sites, e só postam nos canais dos sites cadastrados) e o agendamento `ghostlink-sites-resumo` às 23h de São Paulo, no fuso do próprio Hermes, criado pelo `cron.jobs` do Hermes. Os nomes da tabela da skill vão como dado (código em linha), nunca como instrução. |

Antes de cada escrita o plugin guarda uma cópia do arquivo em `$HERMES_HOME/ghostlink/backups` (as 5 mais novas; as cópias nunca têm chaves). Se um arquivo do Hermes estiver num formato que o plugin não conhece, ele não aplica nada e avisa "versão do Hermes não suportada" no painel.

- Se o `.env` do próprio Hermes (`$HERMES_HOME/.env`) tiver uma dessas chaves, ela vale mais que a do GhostLink. O painel avisa; remova a chave do `.env`.
- Chave de MCP (ex.: `MACROL_MCP_KEY`): o Hermes conecta os servidores MCP antes de conectar ao GhostLink, então ela fica numa variável do Railway do serviço, não na aba API. Não a coloque também no `.env`, que vale mais.
- `GHOSTLINK_COMPANY_RESTART=s6` reinicia o gateway depois de uma mudança de modelo. Só para um Hermes que lê o `config.yaml` apenas na partida; por padrão não é preciso, porque o Hermes lê tudo a cada mensagem.
- Mudanças feitas no painel com o Hermes desconectado chegam quando ele reconectar. Se a licença Enterprise do servidor vencer, o Hermes tenta de novo a cada 2 minutos.
- Se a licença vencer (o servidor responde `ENTERPRISE_REQUIRED`) ou se o gateway ligar sem `GHOSTLINK_COMPANY=true`, o plugin apaga a skill `ghostlink-sites` e o agendamento `ghostlink-sites-resumo` (pelo `cron.jobs`, para não gastar uma chamada de IA por dia à toa) e esconde as duas ferramentas. Repetir não faz nada; uma falha só vira aviso no log. Quando a licença volta, o próximo `hermes.config` recria tudo.
- Se o ambiente ou o `.env` tiver `GOOGLE_API_KEY`, o Hermes usa essa antes da `GEMINI_API_KEY` do GhostLink. O painel avisa.

## Testes

- `test/ghostlink-client.test.ts`: o cliente Python contra um servidor GhostLink real (precisa de Python com `aiohttp` e `cryptography`; `GHOSTLINK_TEST_PYTHON` escolhe o interpretador).
- `test/company_check.py`: o código do Hermes da empresa (`ghostlink/company.py`) numa pasta de teste, sem Hermes nem rede (precisa de `aiohttp` e `ruamel.yaml`).
- `test/sites_check.py`: o `ghostlink/sites.py` numa pasta de teste (a skill, o agendamento e as duas ferramentas), sem Hermes nem rede.
- `test/adapter_check.py`: o adaptador dentro de uma instalação do Hermes (`python adapter_check.py ghostlink`).
