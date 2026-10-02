// The notification cards' page (main/toasts.ts): shows the cards main sends, oldest at the top, and
// tells main about a click, a × or the mouse over them. No React: a short list, built with DOM calls,
// every text set with textContent (never HTML).
import './toast.css';
import type { ToastIcon, ToastPageApi, ToastUpdate, ToastView } from '../../shared/toast.js';

const api = (window as Window & { ghostlinkToast?: ToastPageApi }).ghostlinkToast;
const stack = document.getElementById('stack') as HTMLOListElement;
const ghost = document.getElementById('ghost') as HTMLTemplateElement;
const closeIcon = document.getElementById('close-icon') as HTMLTemplateElement;
/** The cards on the page, by id: each is built once, so only a new one plays the entry animation. */
const cards = new Map<number, HTMLLIElement>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function picture(icon: ToastIcon): HTMLElement {
  const box = element('span', 'picture');
  switch (icon.kind) {
    case 'ghost':
      box.append(ghost.content.cloneNode(true));
      break;
    case 'initials':
      box.textContent = icon.text;
      break;
    case 'image': {
      const image = element('img', 'pictureImage');
      image.alt = '';
      image.draggable = false;
      // A picture main cannot serve (404) shows the initials instead.
      image.addEventListener(
        'error',
        () => {
          box.textContent = icon.fallback;
        },
        { once: true },
      );
      image.src = icon.url;
      box.append(image);
      break;
    }
  }
  return box;
}

function card(view: ToastView, closeLabel: string): HTMLLIElement {
  const item = element('li', 'card');
  item.addEventListener('click', () => api?.click(view.id));

  const title = element('p', 'title');
  title.textContent = view.title;
  const body = element('p', 'body');
  if (view.author !== null) {
    const author = element('span', 'author');
    author.textContent = `${view.author}:`;
    body.append(author, ' ');
  }
  body.append(view.body);
  const text = element('div', 'text');
  text.append(title, body);

  const close = element('button', 'close');
  close.type = 'button';
  close.title = closeLabel;
  close.setAttribute('aria-label', closeLabel);
  close.append(closeIcon.content.cloneNode(true));
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api?.close(view.id);
  });

  item.append(picture(view.icon), text, close);
  return item;
}

function render(update: ToastUpdate): void {
  document.documentElement.lang = update.lang;
  const shown = new Set(update.toasts.map((view) => view.id));
  for (const [id, node] of cards) {
    if (shown.has(id)) continue;
    node.remove();
    cards.delete(id);
  }
  // A new card is always the newest: it goes at the bottom, the others keep their place (and animation).
  for (const view of update.toasts) {
    if (cards.has(view.id)) continue;
    const node = card(view, update.closeLabel);
    cards.set(view.id, node);
    stack.append(node);
  }
}

// Over the window, none of the cards leaves; main starts their time again once the mouse is out.
document.documentElement.addEventListener('mouseenter', () => api?.hover(true));
document.documentElement.addEventListener('mouseleave', () => api?.hover(false));
api?.onUpdate(render);
