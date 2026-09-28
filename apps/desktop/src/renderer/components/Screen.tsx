import type { ReactNode } from 'react';
import { APP_NAME } from '@ghostlink/shared';
import { useT } from '../i18n/index.js';
import ui from './ui.module.css';

/** A centered card with the app header: the frame of every Milestone 1 screen. */
export function Screen({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <main className={ui.screen}>
      <section className={wide ? `${ui.card} ${ui.wide}` : ui.card} aria-labelledby="screen-title">
        <header className={ui.brand}>
          <span className={ui.logo} aria-hidden="true" />
          <span>{APP_NAME}</span>
          <span className={ui.badge}>{t('app.beta')}</span>
        </header>
        <h1 id="screen-title" className={ui.title}>
          {title}
        </h1>
        {children}
      </section>
    </main>
  );
}

/** A translated error line, or nothing. */
export function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p className={ui.error} role="alert">
      {text}
    </p>
  ) : null;
}
