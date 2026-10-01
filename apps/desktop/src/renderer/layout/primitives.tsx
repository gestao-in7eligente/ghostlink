// Small building blocks of the main screen: avatar, dialog, menu and select. Dialogs trap
// focus and close on Esc; menus and selects move with the arrow keys (keyboard access, spec §11).
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { avatarFace, initialsFontSize } from '../features/profile/avatarModel.js';
import { errorMessage, useT } from '../i18n/index.js';
import { avatarHashFor, useMyAvatar } from '../stores/profile.js';
import p from './primitives.module.css';
import { isTypeaheadKey, selectMove, selectTypeahead } from './selectModel.js';

// ---- avatar ----

/**
 * A person's avatar (spec 2026-10-01-foto-de-perfil §6): their photo, or their initials on a
 * blurple circle when there is none or it fails to load, with an optional presence dot.
 * `self`: my own, shown from the profile store so a change appears at once.
 */
export function Avatar({
  name,
  hash = null,
  size = 40,
  online = null,
  self = false,
}: {
  name: string;
  /** The member's photo hash (from the server), or null. */
  hash?: string | null;
  size?: number;
  online?: boolean | null;
  self?: boolean;
}) {
  const shown = avatarHashFor(self, hash, useMyAvatar(self));
  const [failed, setFailed] = useState<string | null>(null);
  const face = avatarFace(shown, failed, name);
  return (
    <span
      className={face.kind === 'image' ? `${p.avatar} ${p.avatarPhoto}` : p.avatar}
      style={{ width: size, height: size, fontSize: initialsFontSize(size) }}
      aria-hidden="true"
      data-avatar={face.kind}
    >
      {face.kind === 'image' ? <img className={p.avatarImage} src={face.src} alt="" draggable={false} onError={() => setFailed(shown)} /> : face.text}
      {online !== null && <span className={online ? `${p.dot} ${p.dotOn}` : p.dot} />}
    </span>
  );
}

// ---- focus helpers ----

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Puts focus back where it was when the component unmounts. */
function useRestoreFocus(): void {
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);
}

// ---- dialog ----

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'small' | 'medium' | 'full';
  /** Element that gets the first focus; defaults to the first focusable one. */
  initialFocus?: string;
}

/** A modal dialog: Esc and the backdrop close it, Tab stays inside, focus returns afterwards. */
export function Modal({ title, onClose, children, footer, size = 'small', initialFocus }: ModalProps) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useRestoreFocus();

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const first = (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ?? focusables(root)[0] ?? root;
    first.focus();
  }, [initialFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const list = focusables(ref.current);
    if (list.length === 0) return;
    const first = list[0]!;
    const last = list.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={p.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`${p.dialog} ${p[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={p.dialogHeader}>
          <h2 id={titleId} className={p.dialogTitle}>
            {title}
          </h2>
          <button type="button" className={p.iconButton} onClick={onClose} aria-label={t('ui.close')} title={t('ui.close')}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className={p.dialogBody}>{children}</div>
        {footer && <footer className={p.dialogFooter}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Yes/no confirmation with a destructive primary button. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  danger = true,
  children,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'INTERNAL');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${danger ? p.buttonDanger : p.buttonPrimary}`} onClick={() => void confirm()} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className={p.stack}>
        {typeof body === 'string' ? <p className={p.text}>{body}</p> : body}
        {children}
        {error && <ErrorText code={error} />}
      </div>
    </Modal>
  );
}

/** A translated error line for a rejected request (the message is the error code). */
export function ErrorText({ code }: { code: string }) {
  const t = useT();
  return (
    <p className={p.error} role="alert">
      {errorMessage(t, code)}
    </p>
  );
}

// ---- menu ----

export type MenuAnchor = { x: number; y: number } | DOMRect;

export interface MenuProps {
  anchor: MenuAnchor;
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Horizontal alignment to a DOMRect anchor. */
  align?: 'start' | 'end';
  width?: number;
}

/** A floating menu: arrow keys, Home/End, Esc and Tab; a click outside closes it. */
export function Menu({ anchor, label, onClose, children, align = 'start', width = 220 }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useRestoreFocus();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left: number;
    let top: number;
    if ('width' in anchor) {
      left = align === 'end' ? anchor.right - rect.width : anchor.left;
      top = anchor.bottom + 4;
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, ('width' in anchor ? anchor.top - 4 : top) - rect.height);
    setPos({ left, top });
    const first = el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    (first ?? el).focus();
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current();
    };
    const onBlur = () => close.current();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const el = ref.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(items.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        close.current();
        break;
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={p.menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  children,
  onSelect,
  danger = false,
  disabled = false,
  icon,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? `${p.menuItem} ${p.menuDanger}` : p.menuItem}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => !disabled && onSelect()}
    >
      <span className={p.menuLabel}>{children}</span>
      {icon && <span className={p.menuIcon}>{icon}</span>}
    </button>
  );
}

export function MenuCheckbox({ children, checked, onToggle, disabled = false, color }: { children: ReactNode; checked: boolean; onToggle: () => void; disabled?: boolean; color?: string | null }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={p.menuItem}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => !disabled && onToggle()}
    >
      <span className={p.menuLabel}>
        {color !== undefined && <span className={p.roleDot} style={color ? { background: color } : undefined} aria-hidden="true" />}
        {children}
      </span>
      <span className={checked ? `${p.check} ${p.checkOn}` : p.check} aria-hidden="true">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className={p.menuSeparator} role="separator" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className={p.menuHeading}>{children}</div>;
}

// ---- select ----

export interface SelectOption<V extends string | number> {
  value: V;
  label: string;
  /** A second, quieter line under the label. */
  hint?: string;
}

export interface SelectProps<V extends string | number> {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** The id of the visible label (preferred), or a label of its own. */
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Gap between the field and its list, and the list's distance to the window's edges. */
const SELECT_GAP = 4;
const SELECT_MARGIN = 8;
/** About eight options; longer lists scroll. */
const SELECT_MAX_HEIGHT = 312;
const TYPEAHEAD_MS = 600;

/**
 * A dropdown in the app's style (a native <select> opens the system's own light list).
 * The field is a combobox button that keeps the focus; the list (role listbox) opens under
 * it, or over it when there is no room below, and follows the active option with
 * aria-activedescendant. Keys: Enter, Space or the arrows open; the arrows, Home, End and
 * Page keys move; Enter (or Space) chooses; Esc and Tab close; letters jump to an option.
 */
export function Select<V extends string | number>({ value, options, onChange, labelledBy, label, disabled = false, id, className }: SelectProps<V>) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const optionId = (i: number) => `${listId}-${i}`;

  const show = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  /** Closes the list; the focus stays where it went (a click elsewhere, Tab). */
  const dismiss = () => {
    setOpen(false);
    setPos(null);
  };
  /** Closes the list and puts the focus back on the field. */
  const close = () => {
    dismiss();
    triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    close();
    if (option && option.value !== value) onChange(option.value);
  };
  const typeahead = (key: string): number => {
    const now = performance.now();
    const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + key : key;
    typed.current = { text, at: now };
    return selectTypeahead(
      options.map((o) => o.label),
      text,
      open ? active : selectedIndex,
    );
  };

  // Under the field, or over it when it fits better there; as wide as the field.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!open || !trigger || !list) return;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const height = Math.min(list.scrollHeight, SELECT_MAX_HEIGHT);
      const below = window.innerHeight - rect.bottom - SELECT_GAP - SELECT_MARGIN;
      const above = rect.top - SELECT_GAP - SELECT_MARGIN;
      const up = height > below && above > below;
      const maxHeight = Math.min(SELECT_MAX_HEIGHT, Math.max(up ? above : below, 80));
      const top = up ? rect.top - SELECT_GAP - Math.min(height, maxHeight) : rect.bottom + SELECT_GAP;
      setPos({ left: rect.left, top, width: rect.width, maxHeight });
    };
    place();
  }, [open, options.length]);

  // The active option stays in view.
  useLayoutEffect(() => {
    if (open && pos && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  // A click elsewhere, the window losing focus, resizing or scrolling the page closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const target = e.target as Node;
      return !triggerRef.current?.contains(target) && !listRef.current?.contains(target);
    };
    const onDown = (e: MouseEvent) => {
      if (outside(e)) dismiss();
    };
    const onScroll = (e: Event) => {
      if (outside(e)) dismiss();
    };
    const onLeave = () => dismiss();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onLeave);
    window.addEventListener('resize', onLeave);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', onLeave);
    };
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        show(Math.max(selectedIndex, 0));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        show(e.key === 'Home' ? 0 : options.length - 1);
      } else if (isTypeaheadKey(e)) {
        e.preventDefault();
        const match = typeahead(e.key);
        show(match >= 0 ? match : Math.max(selectedIndex, 0));
      }
      return;
    }
    const moved = selectMove(e.key, active, options.length);
    if (moved !== null) {
      e.preventDefault();
      setActive(moved);
      return;
    }
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        choose(active);
        return;
      case 'Escape':
        // Only the list closes, not the dialog around it.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        dismiss();
        return;
    }
    // Space chooses, unless it is part of a name being typed.
    if (e.key === ' ' && performance.now() - typed.current.at >= TYPEAHEAD_MS) {
      e.preventDefault();
      choose(active);
      return;
    }
    if (isTypeaheadKey(e)) {
      e.preventDefault();
      const match = typeahead(e.key);
      if (match >= 0) setActive(match);
    }
  };

  const triggerClass = [p.select, open ? p.selectOpen : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        disabled={disabled}
        className={triggerClass}
        onClick={() => (open ? close() : show(Math.max(selectedIndex, 0)))}
        onKeyDown={onKeyDown}
      >
        <span className={p.selectValue}>{selected?.label ?? ''}</span>
        <ChevronDown size={18} className={p.selectChevron} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : label}
            className={p.selectList}
            style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : { left: -9999, top: -9999 }}
            // The focus stays on the field (aria-activedescendant).
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((option, i) => {
              const isSelected = i === selectedIndex;
              const cls = [p.selectOption, i === active ? p.selectOptionActive : '', isSelected ? p.selectOptionSelected : ''].filter(Boolean).join(' ');
              return (
                <div
                  key={String(option.value)}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  className={cls}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className={p.selectOptionText}>
                    <span className={p.selectOptionLabel}>{option.label}</span>
                    {option.hint && <span className={p.selectOptionHint}>{option.hint}</span>}
                  </span>
                  {isSelected && <Check size={18} strokeWidth={2.5} className={p.selectCheck} aria-hidden="true" />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export { p as primitives };
