import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Modal } from './primitives.js';
import s from './settings.module.css';

export interface SettingsTab {
  id: string;
  label: string;
  content: () => ReactNode;
  danger?: boolean;
}

/** A full-size settings dialog with vertical tabs (arrow keys move between tabs). */
export function SettingsShell({
  title,
  tabs,
  active,
  onSelect,
  onClose,
}: {
  title: string;
  tabs: SettingsTab[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  const onKeyDown = (e: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === current?.id);
    let next = -1;
    if (e.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(tabs[next]!.id);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <Modal title={title} onClose={onClose} size="full">
      <div className={s.shell}>
        <div ref={listRef} className={s.tabs} role="tablist" aria-orientation="vertical" aria-label={title} onKeyDown={onKeyDown}>
          {tabs.map((tab) => {
            const selected = tab.id === current?.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${base}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${base}-panel`}
                tabIndex={selected ? 0 : -1}
                className={[s.tab, selected ? s.tabActive : '', tab.danger ? s.tabDanger : ''].filter(Boolean).join(' ')}
                onClick={() => onSelect(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <section id={`${base}-panel`} role="tabpanel" aria-labelledby={current ? `${base}-tab-${current.id}` : undefined} className={s.panel}>
          {current && (
            <>
              <h3 className={s.panelTitle}>{current.label}</h3>
              {current.content()}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
