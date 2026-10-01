import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, CheckCheck, CornerUpLeft, Pencil, Reply, Trash2 } from 'lucide-react';
import { DM_ATTACHMENTS_MAX, DM_FILE_MAX_BYTES, type DmConversation, type DmMessage } from '../../../shared/dmTypes.js';
import type { Friend } from '../../../shared/friendsTypes.js';
import { useT, type Translate } from '../../i18n/index.js';
import { Avatar, ConfirmDialog } from '../../layout/primitives.js';
import { applyOwn, useDmStore, type DmLog } from '../../stores/dm.js';
import { useSettingsStore } from '../../stores/settings.js';
import { AttachmentList, DropOverlay, useFileDrop, useTray, type AttachmentView, type DownloadHandler, type TrayLimits } from '../attachments/index.js';
import a from '../attachments/attachments.module.css';
import c from '../chat/chat.module.css';
import { formatDay, formatFull, formatStamp, formatTime } from '../chat/grouping.js';
import { parseMarkdown } from '../chat/markdown.js';
import { renderMarkdown, type MarkdownContext } from '../chat/markdownRender.js';
import d from './dm.module.css';
import { DmComposer, type ComposerMode } from './DmComposer.js';
import { buildDmRows, dmAttachmentViews, dmSummary, isTyping, repliedMessage, TYPING_TTL_MS, type DmFileNotes, type DmRow } from './dmModel.js';

const EMPTY: DmMessage[] = [];
/** attachments spec §3: 10 files of up to 25 MB per message. */
const LIMITS: TrayLimits = { maxFiles: DM_ATTACHMENTS_MAX, maxBytes: DM_FILE_MAX_BYTES };
/** Closer than this to the bottom counts as "at the newest message". */
const STICK_PX = 32;
/** Older messages load when the top is this close. */
const PREFETCH_PX = 400;

interface DmEnv {
  t: Translate;
  locale: string;
  md: MarkdownContext;
  messages: readonly DmMessage[];
  myName: string;
  peerName: string;
  canWrite: boolean;
  highlightId: string | null;
  /** A message's files as the shared pieces show them. */
  files(message: DmMessage): AttachmentView[];
  /** "Baixar": saves a file that is here, asks the friend for one that is not. */
  onDownload: DownloadHandler;
  onReply(message: DmMessage): void;
  onEdit(message: DmMessage): void;
  onDelete(message: DmMessage): void;
  onJumpTo(id: string): void;
}

/**
 * The 1:1 conversation in the center of the Home screen (friends spec §8): header, the
 * messages with the server chat's look, and the composer. Keyed by conversation by the caller.
 */
export function DmView({ conversation, friend, name, myName }: { conversation: DmConversation; friend: Friend | null; name: string; myName: string }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  const conv = conversation.id;
  const log = useDmStore((s) => s.logs[conv]);
  const messages = log?.messages ?? EMPTY;
  const [mode, setMode] = useState<ComposerMode>(null);
  const [deleting, setDeleting] = useState<DmMessage | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const toBottom = useRef<() => void>(() => undefined);

  const canWrite = friend?.state === 'friend';
  const online = friend?.state === 'friend' ? friend.online : null;
  const tray = useTray(LIMITS);
  const drop = useFileDrop(tray.add, canWrite);

  useEffect(() => {
    if (highlight === null) return;
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);

  // Opening the conversation, and every new message while it is on screen, marks it read.
  const newest = messages.length > 0 ? messages[messages.length - 1]!.ts : null;
  useEffect(() => {
    if (conversation.unread === 0 || newest === null || log?.status !== 'ready') return;
    const mark = () => {
      if (document.hasFocus()) void window.ghostlink.dm.read(conv, newest).catch(() => undefined);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [conv, conversation.unread, newest, log?.status]);

  const md: MarkdownContext = useMemo(
    () => ({
      classes: { paragraph: c.p, quote: c.quote, codeBlock: c.codeBlock, code: c.code, link: c.link, mention: c.mention, mentionMe: c.mentionMe },
      userName: () => null,
      role: () => null,
      pingsMe: () => false,
      labels: { everyone: '@everyone', formerMember: t('chat.formerMember'), deletedRole: t('chat.unknownRole').replace(/^@/, '') },
      openLink: (url) => void window.ghostlink.app.openExternal(url).catch(() => undefined),
    }),
    [t],
  );

  const notes: DmFileNotes = useMemo(
    () => ({ waiting: t('dm.fileWaiting', { name }), arriving: t('attachments.loading'), loading: (percent) => t('dm.fileLoading', { percent }) }),
    [t, name],
  );

  const env: DmEnv = useMemo(
    () => ({
      t,
      locale,
      md,
      messages,
      myName,
      peerName: name,
      canWrite,
      highlightId: highlight,
      files: (m) => dmAttachmentViews(m.attachments, online === true, notes),
      onDownload: async (item) => {
        const file = messages.flatMap((m) => m.attachments).find((f) => f.hash === item.key);
        if (file?.state === 'ready') await window.ghostlink.dm.saveFile(conv, item.key);
        else await window.ghostlink.dm.fetchFile(conv, item.key);
      },
      onReply: (m) => setMode({ kind: 'reply', message: m }),
      onEdit: (m) => setMode({ kind: 'edit', message: m }),
      onDelete: (m) => setDeleting(m),
      onJumpTo: (id) => {
        document.getElementById(`dm-msg-${id}`)?.scrollIntoView({ block: 'center' });
        setHighlight(id);
      },
    }),
    [t, locale, md, messages, myName, name, canWrite, highlight, online, notes, conv],
  );

  const rows = useMemo(() => buildDmRows(messages.filter((m) => !m.deleted)), [messages]);

  return (
    <div className={a.dropArea} {...drop.handlers}>
      <header className={`${c.header} ${d.header}`}>
        <Avatar size={32} name={name} online={online} />
        <h1 className={c.headerName}>{name}</h1>
        {online !== null && <span className={d.headerStatus}>{t(online ? 'friends.status.online' : 'friends.status.offline')}</span>}
      </header>
      <DmMessages
        conv={conv}
        log={log}
        rows={rows}
        env={env}
        startName={name}
        registerToBottom={(fn) => {
          toBottom.current = fn;
        }}
      />
      <div className={c.composerBand}>
        <TypingLine conv={conv} peer={conversation.peer} name={name} />
        {canWrite && online === false && <p className={d.offline}>{t('dm.offline', { name })}</p>}
        <DmComposer
          conv={conv}
          peerName={name}
          myName={myName}
          canWrite={canWrite}
          mode={mode}
          messages={messages}
          tray={tray}
          limits={LIMITS}
          onMode={setMode}
          onSent={() => toBottom.current()}
        />
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('dm.deleteTitle')}
          body={t('dm.deleteBody')}
          confirmLabel={t('dm.delete')}
          onConfirm={async () => {
            applyOwn(await window.ghostlink.dm.remove(conv, deleting.id));
            if (mode?.message.id === deleting.id) setMode(null);
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {drop.dragging && <DropOverlay target={`@${name}`} maxFiles={DM_ATTACHMENTS_MAX} />}
    </div>
  );
}

/** The scrolling list: sticks to the newest message, keeps its place when older pages go in above. */
function DmMessages({
  conv,
  log,
  rows,
  env,
  startName,
  registerToBottom,
}: {
  conv: string;
  log: DmLog | undefined;
  rows: DmRow[];
  env: DmEnv;
  startName: string;
  registerToBottom: (fn: () => void) => void;
}) {
  const t = env.t;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Before a render that prepends rows, remember the scroll geometry (the DOM still shows the old rows).
  const firstKey = rows.find((r) => r.kind === 'message')?.key ?? null;
  const prevFirst = useRef(firstKey);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  if (prevFirst.current !== firstKey) {
    const el = scrollRef.current;
    if (el && prevFirst.current !== null) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    prevFirst.current = firstKey;
  }

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => registerToBottom(scrollToBottom), [registerToBottom, scrollToBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const a = anchor.current;
    anchor.current = null;
    if (a && !stick.current) el.scrollTop = a.top + (el.scrollHeight - a.height);
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, log?.hasMore, log?.status]);

  const older = () => void useDmStore.getState().loadHistory(conv, true);

  // A short conversation never scrolls, so load older pages until it fills the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && log?.status === 'ready' && log.hasMore && log.older === 'idle' && el.scrollHeight <= el.clientHeight + PREFETCH_PX) older();
  }, [log?.status, log?.hasMore, log?.older, rows]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop < PREFETCH_PX && log?.older === 'idle') older();
  };

  const top = () => {
    if (!log || log.status === 'loading') return <p className={c.listNote}>{t('chat.loadingHistory')}</p>;
    if (log.status === 'error' || log.older === 'error') {
      return (
        <div className={c.listNote}>
          <p>{t('chat.loadError')}</p>
          <button type="button" className={c.linkButton} onClick={() => void useDmStore.getState().loadHistory(conv, log.status === 'ready')}>
            {t('common.tryAgain')}
          </button>
        </div>
      );
    }
    if (log.hasMore) return <p className={c.listNote}>{t('dm.loadingOlder')}</p>;
    return (
      <div className={d.start}>
        <Avatar size={80} name={startName} />
        <h2 className={d.startName}>{startName}</h2>
        <p className={d.startText}>{t('dm.start', { name: startName })}</p>
        <p className={d.startHint}>{t('dm.startHint')}</p>
      </div>
    );
  };

  return (
    <div className={c.listWrap}>
      <div ref={scrollRef} className={c.scroller} onScroll={onScroll} tabIndex={0} role="region" aria-label={t('dm.region', { name: startName })}>
        <div className={d.list}>
          {top()}
          {rows.map((row) => (
            <DmRowView key={row.key} row={row} env={env} />
          ))}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className={c.jump} onClick={scrollToBottom}>
          <ArrowDown size={15} aria-hidden="true" />
          {t('chat.jumpToPresent')}
        </button>
      )}
    </div>
  );
}

function Content({ text, md }: { text: string; md: MarkdownContext }) {
  const nodes = useMemo(() => renderMarkdown(parseMarkdown(text), md), [text, md]);
  return <>{nodes}</>;
}

function ReplyPreview({ message, env }: { message: DmMessage; env: DmEnv }) {
  const replied = repliedMessage(env.messages, message.replyTo);
  const author = replied ? (replied.mine ? env.myName : env.peerName) : null;
  const text = !replied ? env.t('dm.replyUnknown') : replied.deleted ? env.t('chat.deletedMessage') : dmSummary(replied);
  const live = replied !== null && !replied.deleted;
  return (
    <button type="button" className={c.replyBar} onClick={() => live && env.onJumpTo(replied.id)} disabled={!live}>
      <CornerUpLeft size={14} className={c.replyIcon} aria-hidden="true" />
      {author && <span className={c.replyAuthor}>@{author}</span>}
      <span className={live ? c.replyText : `${c.replyText} ${c.replyDeleted}`}>{text}</span>
    </button>
  );
}

const DmRowView = memo(function DmRowView({ row, env }: { row: DmRow; env: DmEnv }) {
  const t = env.t;
  if (row.kind === 'date') {
    return (
      <div className={c.dateSeparator} role="separator" aria-label={formatDay(row.at, env.locale)}>
        <span>{formatDay(row.at, env.locale)}</span>
      </div>
    );
  }
  const m = row.message;
  const name = m.mine ? env.myName : env.peerName;
  const classes = [c.msg, row.head ? c.msgHead : '', env.highlightId === m.id ? c.msgHighlight : ''];
  return (
    <div id={`dm-msg-${m.id}`} className={classes.filter(Boolean).join(' ')} role="article" aria-label={`${name}, ${formatStamp(m.ts, env.locale)}`}>
      {m.replyTo !== null && <ReplyPreview message={m} env={env} />}
      {row.head ? (
        <Avatar size={40} name={name} self={m.mine} />
      ) : (
        <time className={c.gutter} dateTime={new Date(m.ts).toISOString()} title={formatFull(m.ts, env.locale)}>
          {formatTime(m.ts, env.locale)}
        </time>
      )}
      <div className={c.msgBody}>
        {row.head && (
          <div className={c.msgHeader}>
            <span className={c.author}>{name}</span>
            <time className={c.stamp} dateTime={new Date(m.ts).toISOString()} title={formatFull(m.ts, env.locale)}>
              {formatStamp(m.ts, env.locale)}
            </time>
          </div>
        )}
        {m.text !== '' && (
          <div className={c.content}>
            <Content text={m.text} md={env.md} />
            {m.editedAt !== null && (
              <span className={c.edited} title={formatFull(m.editedAt, env.locale)}>
                {' '}
                {t('chat.edited')}
              </span>
            )}
            {m.mine && <DeliveryMark delivered={m.delivered} t={t} />}
          </div>
        )}
        {m.attachments.length > 0 && <AttachmentList items={env.files(m)} onDownload={env.onDownload} />}
        {/* A message of files alone: the mark goes under them. */}
        {m.text === '' && m.mine && (
          <div className={c.content}>
            <DeliveryMark delivered={m.delivered} t={t} />
          </div>
        )}
      </div>
      {env.canWrite && (
        <div className={c.actions} role="toolbar" aria-label={t('chat.messageActions')}>
          <button type="button" className={c.action} aria-label={t('chat.reply')} title={t('chat.reply')} onClick={() => env.onReply(m)}>
            <Reply size={17} aria-hidden="true" />
          </button>
          {m.mine && (
            <>
              <button type="button" className={c.action} aria-label={t('chat.edit')} title={t('chat.edit')} onClick={() => env.onEdit(m)}>
                <Pencil size={16} aria-hidden="true" />
              </button>
              <button type="button" className={`${c.action} ${c.actionDanger}`} aria-label={t('dm.delete')} title={t('dm.delete')} onClick={() => env.onDelete(m)}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** ✓ sent, ✓✓ delivered (friends spec §4.3), after my own messages. */
function DeliveryMark({ delivered, t }: { delivered: boolean; t: Translate }) {
  const label = t(delivered ? 'dm.delivered' : 'dm.sent');
  return (
    <span className={delivered ? `${d.mark} ${d.markDelivered}` : d.mark} role="img" aria-label={label} title={label}>
      {delivered ? <CheckCheck size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
    </span>
  );
}

/** "{name} está digitando…", gone 5 s after the last signal. */
function TypingLine({ conv, peer, name }: { conv: string; peer: string; name: string }) {
  const t = useT();
  const since = useDmStore((s) => s.typing[conv]?.[peer]);
  const [, tick] = useState(0);
  const typing = isTyping(since, Date.now());
  useEffect(() => {
    if (since === undefined || !typing) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, since + TYPING_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since, typing]);
  return (
    <div className={c.typing} aria-live="polite">
      {typing && (
        <>
          <span className={c.typingDots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {t('dm.typing', { name })}
        </>
      )}
    </div>
  );
}
