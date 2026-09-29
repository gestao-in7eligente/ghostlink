import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/index.js';
import c from './chat.module.css';
import { EMOJI } from './emoji.js';

const COLUMNS = 8;

/** A small emoji grid above (or below) an anchor. Arrow keys move, Enter picks, Esc closes. */
export function EmojiPicker({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (emoji: string) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - margin));
    const above = anchor.top - rect.height - 6;
    const top = above >= margin ? above : Math.min(anchor.bottom + 6, window.innerHeight - rect.height - margin);
    setPos({ left, top });
    el.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current();
    };
    const onBlur = () => close.current();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    if (e.key in step) {
      e.preventDefault();
      const next = i + step[e.key]!;
      if (next >= 0 && next < buttons.length) buttons[next]!.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close.current();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={c.emojiPicker}
      role="dialog"
      aria-label={t('chat.emojiPicker')}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={onKeyDown}
    >
      {EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className={c.emojiButton}
          tabIndex={-1}
          aria-label={emoji}
          onClick={() => {
            onPick(emoji);
            close.current();
          }}
        >
          {emoji}
        </button>
      ))}
    </div>,
    document.body,
  );
}
