import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CirclePlus, Code, SendHorizontal, Smile, X } from 'lucide-react';
import { DM_TEXT_MAX, type DmMessage } from '../../../shared/dmTypes.js';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { applyOwn, useDmStore } from '../../stores/dm.js';
import c from '../chat/chat.module.css';
import { EmojiPicker } from '../chat/EmojiPicker.js';
import { plainDm } from './dmModel.js';

export type ComposerMode = { kind: 'reply' | 'edit'; message: DmMessage } | null;

const MAX_HEIGHT_RATIO = 0.4;

/**
 * The message box of a conversation, the server chat's look without mentions: Enter sends,
 * Shift+Enter breaks the line, ↑ on an empty box edits my last message, Esc leaves reply or edit.
 */
export function DmComposer({
  conv,
  peerName,
  myName,
  canWrite,
  mode,
  messages,
  onMode,
  onSent,
}: {
  conv: string;
  peerName: string;
  myName: string;
  canWrite: boolean;
  mode: ComposerMode;
  messages: readonly DmMessage[];
  onMode: (mode: ComposerMode) => void;
  onSent: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(() => useDmStore.getState().drafts[conv] ?? '');
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const savedDraft = useRef('');
  const editing = mode?.kind === 'edit' ? mode.message : null;

  // Entering edit mode keeps the draft aside and loads the message; leaving it brings the draft back.
  const editingId = useRef<string | null>(null);
  useEffect(() => {
    if (!editing) {
      if (editingId.current !== null) {
        editingId.current = null;
        setText(savedDraft.current);
        setError(null);
      }
      return;
    }
    if (editingId.current === null) savedDraft.current = area.current?.value ?? '';
    editingId.current = editing.id;
    setText(editing.text);
    setError(null);
    requestAnimationFrame(() => {
      const el = area.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    // Only when the edited message changes.
  }, [editing?.id]);

  useEffect(() => {
    if (mode?.kind === 'reply') area.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (!editing) useDmStore.getState().setDraft(conv, text);
  }, [text, editing, conv]);

  // Grow with the text, up to 40% of the window.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    if (text === '') return;
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * MAX_HEIGHT_RATIO)}px`;
  }, [text]);

  const content = text.trim();
  const tooLong = text.length > DM_TEXT_MAX;

  const insert = (snippet: string, caretOffset = snippet.length) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + snippet + text.slice(end));
    const at = start + caretOffset;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const codeBlock = () => {
    const el = area.current;
    const selection = text.slice(el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length);
    if (selection) insert(`\`\`\`\n${selection}\n\`\`\``);
    else insert('```\n\n```', 4);
  };

  const cancelMode = () => {
    onMode(null);
    setError(null);
  };

  const submit = async () => {
    if (!canWrite || busy || tooLong || content === '') return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        if (content !== editing.text) applyOwn(await window.ghostlink.dm.edit(conv, editing.id, content));
        cancelMode();
      } else {
        const replyTo = mode?.kind === 'reply' ? mode.message.id : null;
        setText('');
        onMode(null);
        onSent();
        try {
          applyOwn(await window.ghostlink.dm.send(conv, content, replyTo));
        } catch (e) {
          // Nothing was stored: the text comes back to the box.
          setText(text);
          throw e;
        }
      }
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => area.current?.focus());
    }
  };

  const editLastOwn = () => {
    const last = [...messages].reverse().find((m) => m.mine && !m.deleted);
    if (last) onMode({ kind: 'edit', message: last });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape' && mode) {
      e.preventDefault();
      cancelMode();
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && !editing) {
      e.preventDefault();
      editLastOwn();
    }
  };

  const placeholder = canWrite ? t('dm.placeholder', { name: peerName }) : t('dm.notFriend');

  return (
    <div className={c.composerWrap}>
      {mode && (
        <div className={c.modeBar}>
          <span className={c.modeText}>
            {mode.kind === 'edit' ? t('chat.editing') : t('chat.replyingTo', { name: mode.message.mine ? myName : peerName })}
            {mode.kind === 'reply' && <span className={c.modeQuote}> — {plainDm(mode.message.text).slice(0, 80)}</span>}
          </span>
          <button
            type="button"
            className={c.modeCancel}
            onClick={cancelMode}
            aria-label={mode.kind === 'edit' ? t('chat.cancelEdit') : t('chat.cancelReply')}
            title={mode.kind === 'edit' ? t('chat.cancelEdit') : t('chat.cancelReply')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className={canWrite ? c.composer : `${c.composer} ${c.composerDisabled}`}>
        <div className={c.tools}>
          <button type="button" className={c.tool} disabled aria-label={t('chat.attachSoon')} title={t('chat.attachSoon')}>
            <CirclePlus size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={c.tool}
            disabled={!canWrite}
            aria-label={t('chat.emojiPicker')}
            title={t('chat.emojiPicker')}
            onClick={(e) => setEmoji(e.currentTarget.getBoundingClientRect())}
          >
            <Smile size={20} aria-hidden="true" />
          </button>
          <button type="button" className={c.tool} disabled={!canWrite} aria-label={t('chat.codeBlock')} title={t('chat.codeBlock')} onClick={codeBlock}>
            <Code size={20} aria-hidden="true" />
          </button>
        </div>
        <textarea
          ref={area}
          className={c.input}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={!canWrite}
          maxLength={DM_TEXT_MAX * 2}
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            if (e.target.value.trim() !== '' && !editing) void window.ghostlink.dm.typing(conv).catch(() => undefined);
          }}
          onKeyDown={onKeyDown}
        />
        <span className={tooLong ? `${c.counter} ${c.counterOver}` : c.counter} aria-live="polite" title={tooLong ? t('dm.tooLong', { max: DM_TEXT_MAX }) : undefined}>
          {content.length}/{DM_TEXT_MAX}
        </span>
        <button
          type="button"
          className={content === '' ? `${c.send} ${c.sendIdle}` : c.send}
          disabled={!canWrite || busy || tooLong}
          aria-disabled={content === '' || undefined}
          onClick={() => void submit()}
        >
          <SendHorizontal size={16} aria-hidden="true" />
          {editing ? t('serverSettings.save') : t('chat.send')}
        </button>
      </div>
      {error && (
        <p className={c.composerError} role="alert">
          {errorMessage(t, error)}
        </p>
      )}
      {emoji && <EmojiPicker anchor={emoji} onClose={() => setEmoji(null)} onPick={(e) => insert(e)} />}
    </div>
  );
}
