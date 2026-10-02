import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleAlert, CornerDownRight, Eye } from 'lucide-react';
import { roleColorHex } from '@ghostlink/shared';
import { useT, type Translate } from '../../i18n/index.js';
import { Avatar } from '../../layout/primitives.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import type { BotLocal } from '../../stores/textState.js';
import c from '../chat/chat.module.css';
import { formatDay } from '../chat/grouping.js';
import { parseMarkdown } from '../chat/markdown.js';
import { renderMarkdown, type MarkdownContext } from '../chat/markdownRender.js';
import type { MessageEnv } from '../chat/MessageItem.js';
import { nameOf, seenText } from './botsModel.js';
import g from './botPage.module.css';
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
export function fill(template: string, slots: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const slot = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{slot !== undefined && Object.hasOwn(slots, slot) ? slots[slot] : part}</Fragment>;
  });
}

/** The time now, again every `everyMs`, so "há 5 minutos" keeps up while it is on screen. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** "Criado por Ana em 2 de outubro de 2026" (bot page spec); "Criado em …" when the creator is not known. */
export function CreatedLine({ createdBy, createdAt, className = g.created }: { createdBy: string | null; createdAt: number; className?: string }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const members = useTextStore((st) => st.members.byId);
  const date = formatDay(createdAt, locale);
  return (
    <p className={className} data-bot-created>
      {createdBy === null ? t('bots.settings.createdOn', { date }) : t('bots.settings.created', { name: nameOf(members, createdBy, t('chat.formerMember')), date })}
    </p>
  );
}

/** "Online", "Visto por último há 5 minutos" or "Nunca conectou" (`lastSeenAt` undefined: just "Offline"). */
export function SeenLine({ online, lastSeenAt, className = g.created }: { online: boolean; lastSeenAt: number | null | undefined; className?: string }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const now = useNow();
  return (
    <p className={className} data-bot-seen>
      {seenText(t, online, lastSeenAt, now, locale)}
    </p>
  );
}

/** A bot's description ("Sobre", bot page spec) with the chat's safe markdown; @everyone pings nobody here. */
export function BotDescription({ text }: { text: string }) {
  const t = useT();
  const members = useTextStore((st) => st.members.byId);
  const roles = useTextStore((st) => st.server.roles);
  const selfId = useTextStore((st) => st.server.selfId);
  const md: MarkdownContext = useMemo(() => {
    const myRoleIds = Object.hasOwn(members, selfId) ? members[selfId]!.roleIds : [];
    return {
      classes: { paragraph: c.p, quote: c.quote, codeBlock: c.codeBlock, code: c.code, link: c.link, mention: c.mention, mentionMe: c.mentionMe },
      userName: (id) => (Object.hasOwn(members, id) ? members[id]!.nickname : null),
      role: (id) => (Object.hasOwn(roles, id) ? { name: roles[id]!.name, color: roleColorHex(roles[id]!.color) } : null),
      pingsMe: (kind, id) => (kind === 'user' ? id === selfId : myRoleIds.includes(id)),
      labels: { everyone: t('chat.everyone'), formerMember: t('chat.formerMember'), deletedRole: t('chat.unknownRole').replace(/^@/, '') },
      openLink: (url) => void window.ghostlink.app.openExternal(url).catch(() => undefined),
    };
  }, [members, roles, selfId, t]);
  const nodes = useMemo(() => renderMarkdown(parseMarkdown(text, { everyone: false }), md), [text, md]);
  return (
    <div className={`${c.content} ${g.about}`} data-bot-description>
      {nodes}
    </div>
  );
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
