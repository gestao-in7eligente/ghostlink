import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import type { Channel } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { channelLog } from '../../stores/messages.js';
import { useTextStore } from '../../stores/text.js';
import type { ChannelLog } from '../../stores/textState.js';
import { loadHistory } from './actions.js';
import c from './chat.module.css';
import { buildRows, type Row } from './grouping.js';
import { MessageRow, type MessageEnv } from './MessageItem.js';

const EMPTY: never[] = [];
/** Closer than this to the bottom counts as "at the newest message". */
const STICK_PX = 32;
/** Older history loads when the top is this close. */
const PREFETCH_PX = 600;
/** The first row when the whole history is loaded. */
const START_PX = 12;

function estimate(row: Row | undefined): number {
  if (!row) return 120;
  if (row.kind === 'date') return 44;
  const content = row.kind === 'message' ? row.message.content : row.pending.content;
  const lines = Math.max(1, Math.ceil(content.length / 90)) + (content.match(/\n/g)?.length ?? 0);
  const extra = row.kind === 'message' ? (row.message.replyTo ? 22 : 0) + (row.message.reactions.length > 0 ? 34 : 0) : 0;
  return (row.head ? 34 : 4) + lines * 22 + extra;
}

export interface MessageListHandle {
  scrollToBottom(): void;
}

/**
 * The virtualized message list (spec §11.1 item 5). Only the rows near the viewport
 * are in the DOM; it sticks to the newest message, keeps its place when older
 * history is prepended, and loads more when scrolled near the top.
 */
export function MessageList({
  channel,
  env,
  highlight,
  onAttention,
  registerHandle,
}: {
  channel: Channel;
  env: MessageEnv;
  highlight: number | null;
  onAttention: (atBottom: boolean) => void;
  registerHandle: (handle: MessageListHandle | null) => void;
}) {
  const t = useT();
  const log = useTextStore((s) => channelLog(s.messages, channel.id));
  const selfId = useTextStore((s) => s.server.selfId);
  const rows = useMemo(() => buildRows(log?.items ?? EMPTY, log?.pending ?? EMPTY, selfId), [log?.items, log?.pending, selfId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Before a render that prepends rows, remember the scroll geometry (the DOM still shows the old rows).
  const firstKey = rows[0]?.key ?? null;
  const prevFirst = useRef(firstKey);
  const anchor = useRef<{ key: string; height: number; top: number } | null>(null);
  if (prevFirst.current !== firstKey) {
    const el = scrollRef.current;
    if (el && prevFirst.current !== null) anchor.current = { key: prevFirst.current, height: el.scrollHeight, top: el.scrollTop };
    prevFirst.current = firstKey;
  }

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (i === 0 ? (log?.hasMore === false ? START_PX : 56) : estimate(rows[i - 1])),
    getItemKey: (i) => (i === 0 ? 'top' : rows[i - 1]!.key),
    overscan: 12,
  });
  const total = virtualizer.getTotalSize();

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    registerHandle({ scrollToBottom: toBottom });
    return () => registerHandle(null);
  }, [registerHandle, toBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const a = anchor.current;
    anchor.current = null;
    if (a && !stick.current && rows.some((r) => r.key === a.key)) {
      // Older messages went in above: keep the same messages on screen.
      el.scrollTop = a.top + (el.scrollHeight - a.height);
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rows, total]);

  // A short channel never scrolls, so load older pages until it fills the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && log?.status === 'ready' && log.hasMore && log.older === 'idle' && el.scrollHeight <= el.clientHeight + PREFETCH_PX) {
      void loadHistory(channel.id, true);
    }
  }, [log?.status, log?.hasMore, log?.older, total, channel.id]);

  useEffect(() => onAttention(atBottom), [atBottom, onAttention]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop < PREFETCH_PX) void loadHistory(channel.id, true);
  };

  // Jump to a quoted message when it is loaded.
  useEffect(() => {
    if (highlight === null) return;
    const index = rows.findIndex((r) => r.kind === 'message' && r.message.id === highlight);
    if (index < 0) return;
    stick.current = false;
    virtualizer.scrollToIndex(index + 1, { align: 'center' });
  }, [highlight, rows, virtualizer]);

  const items = virtualizer.getVirtualItems();
  return (
    <div className={c.listWrap}>
      <div
        ref={scrollRef}
        className={c.scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label={t('chat.messagesIn', { channel: channel.name })}
      >
        <div className={c.canvas} style={{ height: total }}>
          {items.map((item) => (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className={c.slot} style={{ transform: `translateY(${item.start}px)` }}>
              {item.index === 0 ? <ListTop channel={channel} log={log} /> : <MessageRow row={rows[item.index - 1]!} env={env} />}
            </div>
          ))}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className={c.jump} onClick={toBottom}>
          <ArrowDown size={15} aria-hidden="true" />
          {t('chat.jumpToPresent')}
        </button>
      )}
    </div>
  );
}

/** The first row: a loader while older history exists, otherwise a little space above the first date. */
function ListTop({ channel, log }: { channel: Channel; log: ChannelLog | undefined }) {
  const t = useT();
  if (!log || log.status === 'loading') return <p className={c.listNote}>{t('chat.loadingHistory')}</p>;
  if (log.status === 'error') {
    return (
      <div className={c.listNote}>
        <p>{t('chat.loadError')}</p>
        <button type="button" className={c.linkButton} onClick={() => void loadHistory(channel.id)}>
          {t('common.tryAgain')}
        </button>
      </div>
    );
  }
  if (log.hasMore) {
    return log.older === 'error' ? (
      <div className={c.listNote}>
        <p>{t('chat.loadError')}</p>
        <button type="button" className={c.linkButton} onClick={() => void loadHistory(channel.id, true)}>
          {t('common.tryAgain')}
        </button>
      </div>
    ) : (
      <p className={c.listNote}>{t('chat.loadingHistory')}</p>
    );
  }
  return <div className={c.listStart} />;
}
