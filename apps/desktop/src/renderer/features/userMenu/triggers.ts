import type { KeyboardEvent, MouseEvent } from 'react';
import type { MenuAnchor } from '../../layout/primitives.js';

/** A person's menu waiting to show: whose, where, and the name, picture or row it came from. */
export interface UserMenuRequest {
  userId: string;
  anchor: MenuAnchor;
  opener: HTMLElement;
}

/**
 * What opens a person's menu on their name, picture or row (spec 2026-10-02-menu-do-usuario §1):
 * the right click at the pointer, the menu key or Shift+F10 under the element. The left click
 * stays the profile card's.
 */
export function userMenuTriggers(open: (anchor: MenuAnchor, opener: HTMLElement) => void) {
  return {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      open({ x: e.clientX, y: e.clientY }, e.currentTarget);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      open(e.currentTarget.getBoundingClientRect(), e.currentTarget);
    },
  };
}
