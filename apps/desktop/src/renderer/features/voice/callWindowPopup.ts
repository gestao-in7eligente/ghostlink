// The call's mini window as a popup of this page (spec 2026-10-02-janelinha-da-chamada-design.md §3):
// window.open('', CALL_WINDOW_NAME) gives a blank page in this same renderer, which main lets
// through and shapes (frameless, on top, out of captures). React then draws into it with a portal,
// so it shares this page's stores and LiveKit tracks. The page has no styles of its own: the app's
// are copied in, and copied again whenever they change (development injects and updates them).
import { CALL_WINDOW_NAME, CALL_WINDOW_SIZE } from '../../../shared/callWindow.js';

/** An open mini window: where React draws, and how to close it. */
export interface CallPopup {
  root: HTMLElement;
  close(): void;
}

/** Marks the copies, so a new copy replaces them. */
const COPY = 'data-app-style';
/** How often a window closed by other means (Alt+F4, the system) is noticed, besides its pagehide. */
const CLOSED_CHECK_MS = 1_000;

/** The app's stylesheets into the popup's head: <style> by its text, <link> by its absolute URL. */
function copyStyles(from: Document, to: Document): void {
  for (const old of to.head.querySelectorAll(`[${COPY}]`)) old.remove();
  for (const node of from.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]')) {
    let copy: HTMLStyleElement | HTMLLinkElement;
    if (node.tagName === 'LINK') {
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = (node as HTMLLinkElement).href;
      copy = link;
    } else {
      copy = to.createElement('style');
      copy.textContent = node.textContent;
    }
    copy.setAttribute(COPY, '');
    to.head.append(copy);
  }
}

/**
 * Opens the mini window and prepares its page; null when it cannot open (main refused it).
 * `onGone`: it was closed by other means than close() (Alt+F4, the system).
 */
export function openCallPopup(opts: { title: string; className?: string; onGone(): void }): CallPopup | null {
  const popup = window.open('', CALL_WINDOW_NAME, `popup,width=${CALL_WINDOW_SIZE.width},height=${CALL_WINDOW_SIZE.height}`);
  if (!popup) return null;
  let doc: Document;
  try {
    doc = popup.document;
  } catch {
    popup.close(); // not this page's (cannot happen: main allows only the blank page it opens)
    return null;
  }
  doc.title = opts.title;
  doc.documentElement.lang = document.documentElement.lang;
  doc.body.replaceChildren();
  copyStyles(document, doc);
  const root = doc.createElement('div');
  if (opts.className) root.className = opts.className;
  doc.body.append(root);

  const styles = new MutationObserver(() => copyStyles(document, doc));
  styles.observe(document.head, { childList: true, subtree: true, characterData: true });
  let done = false;
  const stop = () => {
    done = true;
    styles.disconnect();
    clearInterval(check);
    popup.removeEventListener('pagehide', gone);
    window.removeEventListener('pagehide', closeWithPage);
  };
  function gone() {
    if (done) return;
    stop();
    opts.onGone();
  }
  // This page going (a reload) takes the window with it; main closes it too.
  const closeWithPage = () => popup.close();
  const check = setInterval(() => {
    if (popup.closed) gone();
  }, CLOSED_CHECK_MS);
  popup.addEventListener('pagehide', gone);
  window.addEventListener('pagehide', closeWithPage);
  return {
    root,
    close() {
      if (done) return;
      stop();
      popup.close();
    },
  };
}
