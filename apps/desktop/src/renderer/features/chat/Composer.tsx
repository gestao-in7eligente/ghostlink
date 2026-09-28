import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CirclePlus, Code, SendHorizontal, Smile, X } from 'lucide-react';
import { CHAT_LIMITS, PERMISSIONS, has, type Channel } from '@ghostlink/shared';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { channelLog } from '../../stores/messages.js';
import { myPermissions, rolesByPosition } from '../../stores/server.js';
import { textState, useTextStore } from '../../stores/text.js';
import { editMessage, resetTyping, sendMessage, sendTyping } from './actions.js';
import c from './chat.module.css';
import { useComposerStore } from './composerStore.js';
import { EmojiPicker } from './EmojiPicker.js';
import {
  applyMention,
  decodeMentions,
  encodeMentions,
  mentionQueryAt,
  mentionSuggestions,
  type MentionCandidate,
} from './mentions.js';
import { memberName, plainContent } from './notify.js';

const MAX_HEIGHT_RATIO = 0.4;

/** The message box (owner's UI reference): +, emoji, code, text, counter and "Enviar". */
export function Composer({ channel, canSend, onSent }: { channel: Channel; canSend: boolean; onSent: () => void }) {
  const t = useT();
  const listId = useId();
  const draft = useComposerStore((s) => (Object.hasOwn(s.drafts, channel.id) ? s.drafts[channel.id]! : ''));
  const reply = useComposerStore((s) => (s.reply?.channelId === channel.id ? s.reply : null));
  const edit = useComposerStore((s) => (s.edit?.channelId === channel.id ? s.edit : null));
  const members = useTextStore((s) => s.members);
  const server = useTextStore((s) => s.server);
  const [text, setText] = useState(draft);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const saved = useRef({ text: draft, picked: [] as MentionCandidate[] });

  const canMentionEveryone = useMemo(() => has(myPermissions({ server, members }, channel), PERMISSIONS.MENTION_EVERYONE), [server, members, channel]);

  // Entering edit mode keeps the draft aside and loads the message (tokens shown as names);
  // leaving it, however it ends (Esc, save, a reply started meanwhile), brings the draft back.
  const editingId = useRef<number | null>(null);
  useEffect(() => {
    if (!edit) {
      if (editingId.current !== null) {
        editingId.current = null;
        setText(saved.current.text);
        setPicked(saved.current.picked);
        setError(null);
      }
      return;
    }
    const message = channelLog(textState().messages, channel.id)?.items.find((m) => m.id === edit.messageId);
    if (!message) {
      useComposerStore.getState().cancel();
      return;
    }
    // Switching from one edit to another keeps the original draft.
    if (editingId.current === null) saved.current = { text: area.current?.value ?? '', picked };
    editingId.current = edit.messageId;
    const decoded = decodeMentions(message.content, {
      member: (id) => (Object.hasOwn(textState().members.byId, id) ? textState().members.byId[id] : undefined),
      role: (id) => (Object.hasOwn(textState().server.roles, id) ? textState().server.roles[id] : undefined),
      everyoneLabel: t('chat.everyone'),
    });
    setText(decoded.text);
    setPicked(decoded.picked);
    setError(null);
    requestAnimationFrame(() => {
      const el = area.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    // Only when the edited message changes: the draft and t are read at that moment.
  }, [edit?.messageId]);

  useEffect(() => {
    if (reply) area.current?.focus();
  }, [reply]);

  // "Mencionar" in the member menu: append the mention and focus the box.
  const mention = useComposerStore((s) => s.mention);
  useEffect(() => {
    if (!mention || !canSend) return;
    useComposerStore.getState().requestMention(null);
    const current = area.current?.value ?? '';
    const next = `${current}${current === '' || /\s$/u.test(current) ? '' : ' '}${mention.display} `;
    setText(next);
    setPicked((list) => [...list.filter((x) => x.display !== mention.display), mention]);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }, [mention, canSend]);

  // Keep the draft of the channel (not while editing).
  useEffect(() => {
    if (!edit) useComposerStore.getState().setDraft(channel.id, text);
  }, [text, edit, channel.id]);

  // Grow with the text, up to 40% of the window.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    // Empty: one line (a long placeholder is cut with an ellipsis instead of growing the box).
    if (text === '') return;
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * MAX_HEIGHT_RATIO)}px`;
  }, [text]);

  const encoded = useMemo(() => encodeMentions(text, picked), [text, picked]);
  const length = encoded.trim().length;
  const tooLong = encoded.length > CHAT_LIMITS.messageMaxLength;

  const query = canSend ? mentionQueryAt(text, caret) : null;
  const suggestions = useMemo(() => {
    if (!query || dismissed === query.start) return [];
    return mentionSuggestions(query.query, {
      members: Object.values(members.byId),
      roles: rolesByPosition(server.roles),
      canMentionEveryone,
      everyoneLabel: t('chat.everyone'),
    });
  }, [query?.query, query?.start, dismissed, members, server.roles, canMentionEveryone, t]);
  const open = suggestions.length > 0;
  const active = Math.min(selected, Math.max(0, suggestions.length - 1));

  const pick = (candidate: MentionCandidate) => {
    if (!query) return;
    const next = applyMention(text, query.start, caret, candidate);
    setText(next.text);
    setPicked((list) => [...list.filter((c2) => c2.display !== candidate.display), candidate]);
    setCaret(next.caret);
    setSelected(0);
    requestAnimationFrame(() => area.current?.setSelectionRange(next.caret, next.caret));
  };

  const insert = (snippet: string, caretOffset = snippet.length) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    const at = start + caretOffset;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const codeBlock = () => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selection = text.slice(start, end);
    if (selection) insert(`\`\`\`\n${selection}\n\`\`\``);
    else insert('```\n\n```', 4);
  };

  /** Leaves reply or edit mode (the edit effect restores the draft). */
  const cancelMode = () => {
    useComposerStore.getState().cancel();
    setError(null);
  };

  const submit = async () => {
    if (!canSend || busy || tooLong) return;
    const content = encoded.trim();
    if (edit) {
      const message = channelLog(textState().messages, channel.id)?.items.find((m) => m.id === edit.messageId);
      if (!content || !message) return;
      setBusy(true);
      try {
        if (content !== message.content) await editMessage(edit.messageId, content);
        cancelMode();
      } catch (e) {
        setError(errorCodeOf(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!content) return;
    const replyTo = reply?.messageId ?? null;
    setText('');
    setPicked([]);
    setError(null);
    useComposerStore.getState().cancel();
    resetTyping();
    onSent();
    await sendMessage(channel.id, content, replyTo);
  };

  const editLastOwn = () => {
    const items = channelLog(textState().messages, channel.id)?.items ?? [];
    const self = textState().server.selfId;
    const last = [...items].reverse().find((m) => m.authorId === self);
    if (last) useComposerStore.getState().startEdit({ channelId: channel.id, messageId: last.id });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(query!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape' && (reply || edit)) {
      e.preventDefault();
      cancelMode();
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && !edit) {
      e.preventDefault();
      editLastOwn();
    }
  };

  const replyMessage = reply ? channelLog(textState().messages, channel.id)?.items.find((m) => m.id === reply.messageId) : undefined;
  const placeholder = canSend ? t('chat.placeholder', { channel: channel.name }) : t('chat.readOnly');

  return (
    <div className={c.composerWrap}>
      {open && (
        <ul id={listId} className={c.mentions} role="listbox" aria-label={t('chat.mentionSuggestions')}>
          {suggestions.map((s, i) => (
            <li
              key={s.token}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? `${c.mentionOption} ${c.mentionActive}` : c.mentionOption}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className={c.mentionName}>{s.display}</span>
              <span className={c.mentionKind}>{t(`chat.mentionKind.${s.kind}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {(reply || edit) && (
        <div className={c.modeBar}>
          <span className={c.modeText}>
            {edit
              ? t('chat.editing')
              : t('chat.replyingTo', { name: memberName(textState(), replyMessage?.authorId ?? null, t('chat.formerMember')) })}
            {reply && replyMessage && <span className={c.modeQuote}> — {plainContent(textState(), replyMessage.content, t).slice(0, 80)}</span>}
          </span>
          <button type="button" className={c.modeCancel} onClick={cancelMode} aria-label={edit ? t('chat.cancelEdit') : t('chat.cancelReply')} title={edit ? t('chat.cancelEdit') : t('chat.cancelReply')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className={canSend ? c.composer : `${c.composer} ${c.composerDisabled}`}>
        <div className={c.tools}>
          <button type="button" className={c.tool} disabled aria-label={t('chat.attachSoon')} title={t('chat.attachSoon')}>
            <CirclePlus size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={c.tool}
            disabled={!canSend}
            aria-label={t('chat.emojiPicker')}
            title={t('chat.emojiPicker')}
            onClick={(e) => setEmoji(e.currentTarget.getBoundingClientRect())}
          >
            <Smile size={20} aria-hidden="true" />
          </button>
          <button type="button" className={c.tool} disabled={!canSend} aria-label={t('chat.codeBlock')} title={t('chat.codeBlock')} onClick={codeBlock}>
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
          disabled={!canSend}
          maxLength={CHAT_LIMITS.messageMaxLength * 2}
          spellCheck
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => {
            const value = e.target.value;
            const at = e.target.selectionStart;
            setText(value);
            setCaret(at);
            setSelected(0);
            // A dismissed suggestion list stays closed only while that same @query is being typed.
            setDismissed((d) => (d !== null && mentionQueryAt(value, at)?.start === d ? d : null));
            setError(null);
            if (value.trim() !== '' && !edit) sendTyping(channel.id);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <span className={tooLong ? `${c.counter} ${c.counterOver}` : c.counter} aria-live="polite">
          {length}/{CHAT_LIMITS.messageMaxLength}
        </span>
        <button
          type="button"
          className={length === 0 ? `${c.send} ${c.sendIdle}` : c.send}
          disabled={!canSend || busy || tooLong}
          aria-disabled={length === 0 || undefined}
          onClick={() => void submit()}
        >
          <SendHorizontal size={16} aria-hidden="true" />
          {edit ? t('serverSettings.save') : t('chat.send')}
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
