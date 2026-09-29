import { useEffect, useRef, type ReactNode } from 'react';
import host from './host.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal over whatever screen is open: dark backdrop, Esc closes, Tab stays
 * inside, and focus returns to where it was when the dialog closes.
 */
export function HostDialog({
  title,
  status,
  closeLabel,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  /** Shown next to the title (the server's state pill). */
  status?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div className={host.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-dialog-title"
        tabIndex={-1}
        className={wide ? `${host.dialog} ${host.dialogWide}` : host.dialog}
      >
        <header className={host.dialogHeader}>
          <div className={host.dialogHeading}>
            <h1 id="host-dialog-title" className={host.dialogTitle}>
              {title}
            </h1>
            {status}
          </div>
          <button type="button" className={host.close} onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className={host.dialogBody}>{children}</div>
      </section>
    </div>
  );
}
