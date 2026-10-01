import { memo, useMemo, type MouseEvent } from 'react';
import { CornerUpLeft, Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react';
import type { Attachment, Message } from '@ghostlink/shared';
import { errorMessage, type Translate } from '../../i18n/index.js';
import { Avatar } from '../../layout/primitives.js';
import type { PendingFile, PendingMessage } from '../../stores/textState.js';
import type { AttachmentView, UploadView } from '../attachments/attachmentModel.js';
import { AttachmentList } from '../attachments/AttachmentList.js';
import { UploadProgress } from '../attachments/UploadProgress.js';
import c from './chat.module.css';
import { formatDay, formatFull, formatStamp, formatTime, type Row } from './grouping.js';
import { parseMarkdown } from './markdown.js';
import { renderMarkdown, type MarkdownContext } from './markdownRender.js';

/** Everything a row needs from its surroundings; built once per list render. */
export interface MessageEnv {
  t: Translate;
  locale: string;
  selfId: string;
  canManageMessages: boolean;
  canReact: boolean;
  md: MarkdownContext;
  /** A member's nickname, or "ex-membro". */
  name(userId: string | null): string;
  /** A member's photo hash, or null (initials). */
  avatar(userId: string | null): string | null;
  /** Message text without markup, mentions shown as names (reply previews). */
  plain(content: string): string;
  /** Where the page loads one of this server's files from (main's app:// route), or null. */
  fileUrl(fileId: string): string | null;
  /** True when the message pings the current user (a mention, their role or @everyone). */
  pingsMe(message: Message): boolean;
  highlightId: number | null;
  onReply(message: Message): void;
  onEdit(message: Message): void;
  onDelete(message: Message): void;
  onPickReaction(message: Message, anchor: DOMRect): void;
  onToggleReaction(message: Message, emoji: string): void;
  onJumpTo(id: number): void;
  onRetry(pending: PendingMessage): void;
  onDrop(pending: PendingMessage): void;
}

function Content({ content, everyone, md }: { content: string; everyone: boolean; md: MarkdownContext }) {
  const nodes = useMemo(() => renderMarkdown(parseMarkdown(content, { everyone }), md), [content, everyone, md]);
  return <>{nodes}</>;
}

/** A server's files as the shared list shows them (anexos §4). */
function attachmentViews(attachments: readonly Attachment[], env: MessageEnv): AttachmentView[] {
  return attachments.map((x) => ({ key: x.id, name: x.name, size: x.size, kind: x.kind, mime: x.mime, width: x.width, height: x.height, src: env.fileUrl(x.id) }));
}

function uploadViews(files: readonly PendingFile[]): UploadView[] {
  return files.map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, progress: f.progress, done: f.fileId !== null }));
}

function Header({ name, at, env }: { name: string; at: number; env: MessageEnv }) {
  return (
    <div className={c.msgHeader}>
      <span className={c.author}>{name}</span>
      <time className={c.stamp} dateTime={new Date(at).toISOString()} title={formatFull(at, env.locale)}>
        {formatStamp(at, env.locale)}
      </time>
    </div>
  );
}

function ReplyPreview({ message, env }: { message: Message; env: MessageEnv }) {
  const reply = message.replyTo!;
  const text = reply.deleted ? env.t('chat.deletedMessage') : env.plain(reply.content);
  return (
    <button type="button" className={c.replyBar} onClick={() => !reply.deleted && env.onJumpTo(reply.id)} disabled={reply.deleted}>
      <CornerUpLeft size={14} className={c.replyIcon} aria-hidden="true" />
      <span className={c.replyAuthor}>@{env.name(reply.authorId)}</span>
      <span className={reply.deleted ? `${c.replyText} ${c.replyDeleted}` : c.replyText}>{text}</span>
    </button>
  );
}

function Reactions({ message, env }: { message: Message; env: MessageEnv }) {
  if (message.reactions.length === 0) return null;
  return (
    <div className={c.reactions}>
      {message.reactions.map((r) => {
        const mine = r.userIds.includes(env.selfId);
        const names = r.userIds.slice(0, 10).map((id) => env.name(id)).join(', ');
        const label = env.t('chat.reactedWith', { names, emoji: r.emoji });
        return (
          <button
            key={r.emoji}
            type="button"
            className={mine ? `${c.reaction} ${c.reactionMine}` : c.reaction}
            aria-pressed={mine}
            aria-label={`${label} (${r.userIds.length})`}
            title={label}
            disabled={!env.canReact}
            onClick={() => env.onToggleReaction(message, r.emoji)}
          >
            <span className={c.reactionEmoji}>{r.emoji}</span>
            <span className={c.reactionCount}>{r.userIds.length}</span>
          </button>
        );
      })}
      {env.canReact && message.reactions.length < 20 && (
        <button
          type="button"
          className={`${c.reaction} ${c.reactionAdd}`}
          aria-label={env.t('chat.react')}
          title={env.t('chat.react')}
          onClick={(e: MouseEvent<HTMLButtonElement>) => env.onPickReaction(message, e.currentTarget.getBoundingClientRect())}
        >
          <SmilePlus size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function Actions({ message, env }: { message: Message; env: MessageEnv }) {
  const mine = message.authorId === env.selfId;
  return (
    <div className={c.actions} role="toolbar" aria-label={env.t('chat.messageActions')}>
      {env.canReact && (
        <button
          type="button"
          className={c.action}
          aria-label={env.t('chat.react')}
          title={env.t('chat.react')}
          onClick={(e: MouseEvent<HTMLButtonElement>) => env.onPickReaction(message, e.currentTarget.getBoundingClientRect())}
        >
          <SmilePlus size={17} aria-hidden="true" />
        </button>
      )}
      <button type="button" className={c.action} aria-label={env.t('chat.reply')} title={env.t('chat.reply')} onClick={() => env.onReply(message)}>
        <Reply size={17} aria-hidden="true" />
      </button>
      {mine && (
        <button type="button" className={c.action} aria-label={env.t('chat.edit')} title={env.t('chat.edit')} onClick={() => env.onEdit(message)}>
          <Pencil size={16} aria-hidden="true" />
        </button>
      )}
      {(mine || env.canManageMessages) && (
        <button
          type="button"
          className={`${c.action} ${c.actionDanger}`}
          aria-label={env.t('chat.delete')}
          title={env.t('chat.delete')}
          onClick={() => env.onDelete(message)}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** One row of the message list: a date separator, a message, or one of my messages still sending. */
export const MessageRow = memo(function MessageRow({ row, env }: { row: Row; env: MessageEnv }) {
  if (row.kind === 'date') {
    return (
      <div className={c.dateSeparator} role="separator" aria-label={formatDay(row.at, env.locale)}>
        <span>{formatDay(row.at, env.locale)}</span>
      </div>
    );
  }

  if (row.kind === 'pending') {
    const p = row.pending;
    return (
      <div className={[c.msg, row.head ? c.msgHead : '', c.msgPending].filter(Boolean).join(' ')} role="article">
        {row.head ? <Avatar size={40} name={env.name(env.selfId)} hash={env.avatar(env.selfId)} self /> : <span className={c.gutter} />}
        <div className={c.msgBody}>
          {row.head && <Header name={env.name(env.selfId)} at={p.createdAt} env={env} />}
          {(p.content !== '' || !p.files?.length) && (
            <div className={c.content}>
              <Content content={p.content} everyone={false} md={env.md} />
            </div>
          )}
          {p.files && p.files.length > 0 && <UploadProgress files={uploadViews(p.files)} failed={p.error !== null} />}
          {p.error && (
            <div className={c.failed} role="alert">
              <span>{env.t('chat.sendFailed', { reason: errorMessage(env.t, p.error) })}</span>
              <button type="button" className={c.linkButton} onClick={() => env.onRetry(p)}>
                {env.t('common.tryAgain')}
              </button>
              <button type="button" className={c.linkButton} onClick={() => env.onDrop(p)}>
                {env.t('chat.discard')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const m = row.message;
  const classes = [c.msg, row.head ? c.msgHead : '', env.pingsMe(m) ? c.msgMention : '', env.highlightId === m.id ? c.msgHighlight : ''];
  return (
    <div className={classes.filter(Boolean).join(' ')} role="article" aria-label={`${env.name(m.authorId)}, ${formatStamp(m.createdAt, env.locale)}`}>
      {m.replyTo && <ReplyPreview message={m} env={env} />}
      {row.head ? (
        <Avatar size={40} name={env.name(m.authorId)} hash={env.avatar(m.authorId)} self={m.authorId === env.selfId} />
      ) : (
        <time className={c.gutter} dateTime={new Date(m.createdAt).toISOString()} title={formatFull(m.createdAt, env.locale)}>
          {formatTime(m.createdAt, env.locale)}
        </time>
      )}
      <div className={c.msgBody}>
        {row.head && <Header name={env.name(m.authorId)} at={m.createdAt} env={env} />}
        {(m.content !== '' || m.attachments.length === 0) && (
          <div className={c.content}>
            <Content content={m.content} everyone={m.mentions.everyone} md={env.md} />
            {m.editedAt !== null && (
              <span className={c.edited} title={formatFull(m.editedAt, env.locale)}>
                {' '}
                {env.t('chat.edited')}
              </span>
            )}
          </div>
        )}
        {m.attachments.length > 0 && <AttachmentList items={attachmentViews(m.attachments, env)} />}
        <Reactions message={m} env={env} />
      </div>
      <Actions message={m} env={env} />
    </div>
  );
});
