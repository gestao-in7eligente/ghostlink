// Small building blocks of the main screen: avatar, dialog and menu. Dialogs trap
// focus and close on Esc; menus move with the arrow keys (keyboard access, spec §11).
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
import { Check, X } from 'lucide-react';
import { errorMessage, useT } from '../i18n/index.js';
import p from './primitives.module.css';

// ---- avatar ----

/** The default avatar (avatars are v0.2): a generic silhouette on a gray circle, with an optional presence dot. */
export function Avatar({ size = 40, online = null }: { size?: 32 | 40; online?: boolean | null }) {
  return (
    <span className={p.avatar} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 40 40" width={size} height={size} focusable="false">
        <circle cx="20" cy="15.5" r="6.8" />
        <path d="M8.6 33.5c0-6.6 5-10.4 11.4-10.4s11.4 3.8 11.4 10.4v1.5H8.6z" />
      </svg>
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

export { p as primitives };
