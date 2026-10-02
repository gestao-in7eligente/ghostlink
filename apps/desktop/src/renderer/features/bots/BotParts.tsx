import { Fragment, useMemo, type ReactNode } from 'react';
import { CircleAlert, CornerDownRight, Eye } from 'lucide-react';
import type { Translate } from '../../i18n/index.js';
import { Avatar } from '../../layout/primitives.js';
import type { BotLocal } from '../../stores/textState.js';
import c from '../chat/chat.module.css';
import { parseMarkdown } from '../chat/markdown.js';
import { renderMarkdown } from '../chat/markdownRender.js';
import type { MessageEnv } from '../chat/MessageItem.js';
import b from './bots.module.css';

/** The blurple BOT tag (bots spec §3): next to a bot's name in members, messages and mentions. */
export function BotTag({ t }: { t: Translate }) {
  return (
    <span className={b.tag} data-bot-tag>
      {t('bots.tag')}
    </span>
  );
}

/** Fills a template's `{name}` slots with nodes, so parts of a translated line can be styled. */
function fill(template: string, slots: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const slot = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{slot !== undefined && Object.hasOwn(slots, slot) ? slots[slot] : part}</Fragment>;
  });
}

/** "Fulano usou /comando" (bots spec §3), above a bot's answer, with the person's photo. */
export function UsedCommand({ userId, command, env }: { userId: string; command: string; env: MessageEnv }) {
  const name = env.author(userId, false).name;
  return (
    <div className={b.used} data-interaction-used>
      <CornerDownRight size={14} aria-hidden="true" />
      <Avatar size={16} name={name} hash={env.avatar(userId)} self={userId === env.selfId} />
      <span className={b.usedText}>
        {fill(env.t('slash.used'), {
          name: <span className={b.usedName}>{name}</span>,
          command: <span className={b.usedCommand}>/{command}</span>,
        })}
      </span>
    </div>
  );
}

function BotHeader({ botId, env }: { botId: string; env: MessageEnv }) {
  const { name } = env.author(botId, true);
  return (
    <div className={c.msgHeader}>
      <span className={c.author}>{name}</span>
      <BotTag t={env.t} />
    </div>
  );
}

function EphemeralContent({ content, env }: { content: string; env: MessageEnv }) {
  const nodes = useMemo(() => renderMarkdown(parseMarkdown(content, { everyone: false }), env.md), [content, env.md]);
  return <>{nodes}</>;
}

/**
 * An interaction line only this app shows (bots spec §3): the bot "pensando…", an answer only I
 * see ("Só você pode ver isto · Dispensar"), or "O bot não respondeu".
 */
export function BotLocalRow({ local, env }: { local: BotLocal; env: MessageEnv }) {
  const botName = env.author(local.botId, true).name;
  const own = local.kind === 'ephemeral' || (local.kind === 'thinking' && local.ephemeral);
  const classes = [c.msg, c.msgHead, own ? b.ephemeral : ''].filter(Boolean).join(' ');
  const label =
    local.kind === 'thinking' ? env.t('slash.thinking', { bot: botName }) : local.kind === 'failed' ? env.t('slash.noResponse') : `${botName}, ${env.t('slash.ephemeral')}`;
  return (
    <div className={classes} role="article" aria-label={label} data-bot-local={local.kind}>
      <UsedCommand userId={local.userId} command={local.command} env={env} />
      <Avatar size={40} name={botName} hash={env.avatar(local.botId)} />
      <div className={c.msgBody}>
        <BotHeader botId={local.botId} env={env} />
        {local.kind === 'thinking' && (
          <div className={b.thinking}>
            <span className={c.typingDots} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {env.t('slash.thinking', { bot: botName })}
          </div>
        )}
        {local.kind === 'ephemeral' && (
          <div className={c.content}>
            <EphemeralContent content={local.content} env={env} />
            {local.editedAt !== null && <span className={c.edited}> {env.t('chat.edited')}</span>}
          </div>
        )}
        {local.kind === 'failed' && (
          <div className={b.failed}>
            <CircleAlert size={16} aria-hidden="true" />
            {env.t('slash.noResponse')}
          </div>
        )}
        {own && (
          <div className={b.note}>
            <Eye size={14} aria-hidden="true" />
            <span>{env.t('slash.ephemeral')}</span>
            {local.kind === 'ephemeral' && (
              <>
                <span className={b.noteDot} aria-hidden="true">
                  ·
                </span>
                <button type="button" className={b.dismiss} onClick={() => env.onDismiss(local)}>
                  {env.t('slash.dismiss')}
                </button>
              </>
            )}
          </div>
        )}
        {local.kind === 'failed' && (
          <div className={b.note}>
            <button type="button" className={b.dismiss} onClick={() => env.onDismiss(local)}>
              {env.t('slash.dismiss')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
