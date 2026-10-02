import type { BotCommand, CommandOption } from '@ghostlink/shared';
import { SquareSlash } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { Avatar } from '../../layout/primitives.js';
import { useTextStore } from '../../stores/text.js';
import c from '../chat/chat.module.css';
import { BotTag } from './BotParts.js';
import { isBot } from './botsModel.js';
import g from './botPage.module.css';

const NO_COMMANDS: readonly BotCommand[] = [];

/** A bot's slash commands, from the bots store (the welcome, then commands.updated). */
export function useBotCommands(botId: string): readonly BotCommand[] {
  return useTextStore((s) => (Object.hasOwn(s.bots.commands, botId) ? s.bots.commands[botId]! : NO_COMMANDS));
}

/**
 * The bot's page (bot page spec), in the center in place of the chat when the bot is selected in
 * BOTS: its photo, name, BOT tag and state, and the slash commands it registered. Only what the
 * app already receives; the settings (the bot's menu, "Configurações") hold the rest.
 */
export function BotPage({ botId }: { botId: string }) {
  const t = useT();
  const bot = useTextStore((s) => (Object.hasOwn(s.members.byId, botId) ? s.members.byId[botId] : undefined));
  const commands = useBotCommands(botId);
  // The reducer closes the page when the bot leaves; this covers the frame in between.
  if (!isBot(bot)) return null;
  const status = bot.online ? t('layout.online') : t('members.statusOffline');

  return (
    <div className={g.page} role="region" aria-label={t('bots.page.label', { name: bot.nickname })} data-bot-page={bot.userId}>
      <header className={c.header}>
        <Avatar size={24} name={bot.nickname} hash={bot.avatar} />
        <h1 className={g.headerName}>{bot.nickname}</h1>
        <BotTag t={t} />
      </header>
      <div className={g.scroll}>
        <div className={g.content}>
          <section className={g.profile}>
            <div className={g.banner} />
            <div className={g.profileBody}>
              <span className={g.avatarRing}>
                <Avatar size={80} name={bot.nickname} hash={bot.avatar} online={bot.online} />
              </span>
              <div className={g.identity}>
                <h2 className={g.name}>
                  <span className={g.nameText}>{bot.nickname}</span>
                  <BotTag t={t} />
                </h2>
                <p className={g.status} data-bot-status>
                  <span className={bot.online ? `${g.statusDot} ${g.statusOn}` : g.statusDot} aria-hidden="true" />
                  {status}
                </p>
              </div>
            </div>
          </section>
          <section aria-labelledby="bot-page-commands">
            <h2 id="bot-page-commands" className={g.sectionTitle}>
              {t('bots.page.commands')} — {commands.length}
            </h2>
            <CommandList commands={commands} />
          </section>
        </div>
      </div>
    </div>
  );
}

/** Each command with its description and options (type, required or optional, choices), or the empty state. */
export function CommandList({ commands }: { commands: readonly BotCommand[] }) {
  const t = useT();
  if (commands.length === 0) {
    return (
      <div className={g.empty} data-bot-commands-empty>
        <SquareSlash size={28} aria-hidden="true" />
        <p className={g.emptyTitle}>{t('bots.page.noCommands')}</p>
        <p className={g.emptyHint}>{t('bots.page.noCommandsHint')}</p>
      </div>
    );
  }
  return (
    <ul className={g.commands}>
      {commands.map((command) => (
        <li key={command.name} className={g.command} data-bot-command={command.name}>
          <div className={g.commandHead}>
            <span className={g.commandName}>/{command.name}</span>
            <span className={g.commandDescription}>{command.description}</span>
          </div>
          {command.options.length === 0 ? (
            <p className={g.noOptions}>{t('bots.page.noOptions')}</p>
          ) : (
            <ul className={g.options}>
              {command.options.map((option) => (
                <OptionRow key={option.name} option={option} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function OptionRow({ option }: { option: CommandOption }) {
  const t = useT();
  return (
    <li className={g.option} data-bot-option={option.name}>
      <div className={g.optionHead}>
        <span className={g.optionName}>{option.name}</span>
        <span className={g.badge}>{t(`bots.page.type.${option.type}`)}</span>
        {option.required ? <span className={g.required}>{t('bots.page.required')}</span> : <span className={g.optional}>{t('bots.page.optional')}</span>}
      </div>
      {option.description && <p className={g.optionDescription}>{option.description}</p>}
      {option.choices && option.choices.length > 0 && (
        <p className={g.choices}>
          {t('bots.page.choices')}:
          {option.choices.map((choice) => (
            <span key={String(choice.value)} className={g.choice} title={String(choice.value)}>
              {choice.name}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}
