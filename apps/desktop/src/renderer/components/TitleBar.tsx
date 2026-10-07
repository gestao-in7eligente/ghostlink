import type { ReactNode } from 'react';
import { APP_NAME } from '@ghostlink/shared';
import { GhostMark } from './GhostMark.js';
import t from './TitleBar.module.css';

/**
 * Discord's title bar (owner's reference): 32 px in the rail color, the app name in the
 * middle, draggable. The window draws its own on Windows and Linux (mainWindowOptions:
 * titleBarOverlay keeps only the system buttons); elsewhere env(titlebar-area-height)
 * is 0 and the bar takes no room.
 */
export function TitleBar() {
  return (
    <header className={t.bar}>
      <GhostMark size={16} gold={titleBarGold()} />
      <span className={t.title}>{titleBarName()}</span>
    </header>
  );
}

/** The app's name in the middle of the bar. */
function titleBarName(): string {
  return APP_NAME;
}

/** The black-and-gold mark where the build selects it; the accent mark otherwise. */
function titleBarGold(): boolean {
  return false;
}

/** Everything below the title bar: the screens size themselves to this box, not to the window. */
export function AppBody({ children }: { children: ReactNode }) {
  return <div className={t.body}>{children}</div>;
}
