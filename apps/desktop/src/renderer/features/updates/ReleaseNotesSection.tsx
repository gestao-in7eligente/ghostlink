import { ExternalLink, LoaderCircle } from 'lucide-react';
import { useId, type MouseEvent, type ReactNode } from 'react';
import { releaseTagUrl } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import type { NoteInline, NoteItem } from './releaseNotes.js';
import styles from './UpdateSettings.module.css';

/** What a notes section has to show. */
export type NotesView = { kind: 'loading' } | { kind: 'ready'; items: NoteItem[] } | { kind: 'unavailable' } | { kind: 'missing' };

/** Links leave the app through main, which asks first (app.openExternal, spec §12). */
function openLink(e: MouseEvent, url: string): void {
  e.preventDefault();
  window.ghostlink.app.openExternal(url).catch(() => {});
}

/** The release page on GitHub, or null for a version that is not a release (a development build). */
function releasePage(version: string): string | null {
  try {
    return releaseTagUrl(version);
  } catch {
    return null;
  }
}

/** Parsed notes → React: every string is a text child, so nothing is ever read as HTML. */
function Inlines({ nodes }: { nodes: readonly NoteInline[] }): ReactNode {
  return nodes.map((node, key) => {
    switch (node.k) {
      case 'text':
        return node.text;
      case 'bold':
        return (
          <strong key={key} className={styles.noteBold}>
            <Inlines nodes={node.children} />
          </strong>
        );
      case 'code':
        return (
          <code key={key} className={styles.noteCode}>
            {node.text}
          </code>
        );
      case 'link':
        return (
          <a key={key} href={node.url} title={node.url} rel="noreferrer noopener" className={styles.noteLink} onClick={(e) => openLink(e, node.url)}>
            {node.text}
          </a>
        );
    }
  });
}

/**
 * "O que muda na 0.2.3" / "O que mudou na sua versão (0.2.2)": the bullets, or why there are none
 * with a link to the release on GitHub.
 */
export function ReleaseNotesSection({ title, version, view, fresh = false }: { title: string; version: string; view: NotesView; fresh?: boolean }) {
  const t = useT();
  const titleId = useId();
  const page = releasePage(version);
  let body: ReactNode;
  if (view.kind === 'loading') {
    body = (
      <p className={styles.notesNote}>
        <LoaderCircle size={14} className={styles.spin} aria-hidden="true" />
        {t('updates.page.notesLoading')}
      </p>
    );
  } else if (view.kind === 'ready' && view.items.length > 0) {
    body = (
      <ul className={styles.noteList}>
        {view.items.map((item, i) => (
          <li key={i}>
            <Inlines nodes={item} />
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <p className={styles.notesNote}>
        <span>{t(view.kind === 'unavailable' ? 'updates.page.notesUnavailable' : 'updates.page.notesMissing', { version })}</span>
        {page && (
          <a href={page} title={page} rel="noreferrer noopener" className={styles.noteLink} onClick={(e) => openLink(e, page)}>
            {t('updates.page.notesOnGitHub')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </p>
    );
  }
  return (
    <section className={styles.notes} aria-labelledby={titleId} aria-busy={view.kind === 'loading'}>
      <h3 id={titleId} className={`${styles.notesTitle} ${fresh ? styles.notesTitleNew : ''}`}>
        {title}
      </h3>
      {body}
    </section>
  );
}
