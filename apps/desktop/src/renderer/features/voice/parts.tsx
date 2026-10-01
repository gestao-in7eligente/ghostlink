import { HeadphoneOff, MicOff, Phone } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { VoiceParticipant } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import s from './voice.module.css';

/** A generic silhouette on a gray circle (the reference's default avatar); a green ring while speaking. */
export function VoiceAvatar({ size, speaking = false }: { size: number; speaking?: boolean }) {
  return (
    <span className={speaking ? `${s.avatar} ${s.avatarSpeaking}` : s.avatar} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="8.2" r="4.4" />
        <path d="M3.6 21.4c.7-4.6 4.1-7.4 8.4-7.4s7.7 2.8 8.4 7.4c.1.5-.3.9-.8.9H4.4c-.5 0-.9-.4-.8-.9z" />
      </svg>
    </span>
  );
}

/** Discord's hang-up glyph: a filled handset lying on its back (a phone turned 135°). */
export function HangUpIcon({ size }: { size: number }) {
  return <Phone size={size} fill="currentColor" strokeWidth={1.5} className={s.hangUpIcon} aria-hidden="true" />;
}

/** Mute, deafen and server-mute marks for one participant. */
export function StateIcons({ p, size = 14 }: { p: VoiceParticipant; size?: number }) {
  const t = useT();
  if (!p.muted && !p.deafened && !p.serverMuted) return null;
  return (
    <span className={s.stateIcons}>
      {p.serverMuted ? (
        <MicOff size={size} className={s.stateIconServer} aria-label={t('voice.serverMuted')} role="img" />
      ) : p.muted ? (
        <MicOff size={size} aria-label={t('voice.micOff')} role="img" />
      ) : null}
      {p.deafened && <HeadphoneOff size={size} aria-label={t('voice.soundOff')} role="img" />}
    </span>
  );
}

const FOCUSABLE = '[role^="menuitem"], input, select, button';

const EDGE = 8;

/** Fixed position next to the opener, kept inside the window (the menu lives in a portal). */
function place(menu: HTMLElement, opener: Element | null, placement: 'up' | 'down'): CSSProperties {
  const r = opener?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - menu.offsetWidth - EDGE));
  const top = placement === 'up' ? r.top - menu.offsetHeight - EDGE : r.bottom + 4;
  return { position: 'fixed', left, top: Math.max(EDGE, Math.min(top, window.innerHeight - menu.offsetHeight - EDGE)), bottom: 'auto', right: 'auto' };
}

/**
 * A popover menu, rendered in a portal so no scrolling container clips it: focus moves in
 * on open, arrows move between items, Escape or a click outside closes it and focus
 * returns to the button that opened it.
 */
export function Menu({ label, placement, onClose, children }: { label: string; placement: 'up' | 'down'; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });

  useLayoutEffect(() => {
    if (ref.current) setStyle(place(ref.current, opener.current, placement));
  }, [placement]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      // The opener toggles the menu itself; treating it as "outside" would reopen it.
      if (ref.current?.contains(target) || opener.current?.contains(target)) return;
      close.current();
    };
    const reflow = () => close.current();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', reflow);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', reflow);
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0 || (e.target instanceof HTMLInputElement && e.target.type === 'range')) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]!.focus();
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className={s.menu} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ children, onSelect, danger = false, checked }: { children: ReactNode; onSelect(): void; danger?: boolean; checked?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={danger ? `${s.menuItem} ${s.menuItemDanger}` : s.menuItem}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
