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

## Testes

- `test/ghostlink-client.test.ts`: o cliente Python contra um servidor GhostLink real (precisa de Python com `aiohttp` e `cryptography`; `GHOSTLINK_TEST_PYTHON` escolhe o interpretador).
- `test/adapter_check.py`: o adaptador dentro de uma instalação do Hermes (`python adapter_check.py ghostlink`).
