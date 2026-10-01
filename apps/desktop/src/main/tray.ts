// The tray icon (v0.3.2, as Discord's): the ghost stays near the clock (Windows) / in the menu
// bar (macOS) while the app runs. A click opens the window; the menu has "Abrir GhostLink", the
// hosting entries while a server is hosted here (spec §9), and "Sair do GhostLink".
import { Menu, Notification, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { APP_NAME } from '@ghostlink/shared';
import type { HostStatus } from '../shared/hostTypes.js';
import type { Locale } from '../shared/ipcTypes.js';
import { host as hostEn } from '../renderer/i18n/en/host.js';
import { host as hostPtBR } from '../renderer/i18n/pt-BR/host.js';
import { tray as trayEn } from '../renderer/i18n/tray.en.js';
import { tray as trayPtBR } from '../renderer/i18n/tray.pt-BR.js';

const TEXTS = { 'pt-BR': { ...hostPtBR, ...trayPtBR }, en: { ...hostEn, ...trayEn } } as const;
type TrayKey = Extract<keyof (typeof TEXTS)['pt-BR'], `host.tray.${string}` | `tray.${string}`>;

/** The tray texts come from the renderer's catalogs (pure data), so both stay in one place. */
export function trayText(locale: Locale, key: TrayKey, vars: Readonly<Record<string, string>> = {}): string {
  const template = TEXTS[locale === 'pt-BR' ? 'pt-BR' : 'en'][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : match));
}

/**
 * Closing the window (X) hides it instead of quitting when "Ao fechar, manter na bandeja" is on,
 * and always while a server is hosted here (spec §9). Never while the app is quitting.
 */
export function shouldHideOnClose(s: { closeToTray: boolean; hosting: boolean; quitting: boolean }): boolean {
  return !s.quitting && (s.closeToTray || s.hosting);
}

export type TrayAction = 'open' | 'quit';
export type TrayMenuItem = { type: 'separator' } | { type: 'item'; action: TrayAction; label: string };

/**
 * The right-click menu as data: "Abrir GhostLink", then the hosting entry while a server is hosted
 * here ("Parar servidor e sair"), then "Sair do GhostLink". Quitting always stops a hosted server first.
 */
export function trayMenuItems(locale: Locale, hosting: boolean): TrayMenuItem[] {
  return [
    { type: 'item', action: 'open', label: trayText(locale, 'tray.open') },
    ...(hosting
      ? ([{ type: 'separator' }, { type: 'item', action: 'quit', label: trayText(locale, 'host.tray.stopAndQuit') }] as const)
      : []),
    { type: 'separator' },
    { type: 'item', action: 'quit', label: trayText(locale, 'tray.quit') },
  ];
}

/** "GhostLink", or "GhostLink — hospedando Casa" while a server is hosted here. */
export function trayTooltip(locale: Locale, hostedName: string | null): string {
  return hostedName === null ? APP_NAME : trayText(locale, 'host.tray.tooltip', { name: hostedName });
}

/** The brand blurple (spec §11), the icon's background. */
export const TRAY_BLURPLE = { r: 0x58, g: 0x65, b: 0xf2 } as const;
const EYES = { r: 0x1e, g: 0x1f, b: 0x22 } as const;

/**
 * A ghost on a rounded blurple square (spec §11 icon), drawn in code so the tray
 * needs no image file: premultiplied BGRA, 4×4 supersampled.
 */
export function renderTrayIcon(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const radius = 0.22 * size;
  const sample = (x: number, y: number): { r: number; g: number; b: number } | null => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return null; // outside the rounded square
    const u = x / size;
    const v = y / size;
    for (const ex of [0.41, 0.59]) if ((u - ex) ** 2 + (v - 0.44) ** 2 < 0.058 ** 2) return EYES;
    const inHead = (u - 0.5) ** 2 + (v - 0.45) ** 2 < 0.27 ** 2;
    const bottom = 0.77 + 0.045 * Math.cos(((u - 0.23) / 0.54) * 3 * 2 * Math.PI);
    const inBody = u > 0.23 && u < 0.77 && v >= 0.45 && v < bottom;
    return inHead || inBody ? { r: 255, g: 255, b: 255 } : TRAY_BLURPLE;
  };
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample(px + (sx + 0.5) / n, py + (sy + 0.5) / n);
          if (!c) continue;
          r += c.r;
          g += c.g;
          b += c.b;
          covered++;
        }
      }
      const i = (py * size + px) * 4;
      const total = n * n;
      out[i] = Math.round(b / total);
      out[i + 1] = Math.round(g / total);
      out[i + 2] = Math.round(r / total);
      out[i + 3] = Math.round((covered / total) * 255);
    }
  }
  return out;
}

/** The ghost at `size` points, with 1.5× and 2× representations for high-DPI screens. */
export function ghostImage(size: number): NativeImage {
  const image = nativeImage.createFromBitmap(renderTrayIcon(size), { width: size, height: size, scaleFactor: 1 });
  for (const scaleFactor of [1.5, 2]) {
    const pixels = Math.round(size * scaleFactor);
    image.addRepresentation({ scaleFactor, width: pixels, height: pixels, buffer: renderTrayIcon(pixels) });
  }
  return image;
}

export interface AppTrayDeps {
  locale(): Locale;
  onOpen(): void;
  onQuit(): void;
  platform?: NodeJS.Platform;
}

/** The ghost near the clock, from show() until the app quits. */
export class AppTray {
  readonly #deps: AppTrayDeps;
  #tray: Tray | null = null;
  /** The hosted server's name while its entries are in the menu (starting, running, failed…). */
  #hosted: string | null = null;

  constructor(deps: AppTrayDeps) {
    this.#deps = deps;
  }

  show(): void {
    if (this.#tray) return;
    this.#tray = new Tray(ghostImage(16));
    this.#tray.on('click', () => this.#deps.onOpen());
    this.refresh();
  }

  /** The hosting entries follow the hosted server: there until it is stopped (a failed one too). */
  setHost(status: HostStatus): void {
    const hosted = status.state === 'stopped' || status.config === null ? null : status.config.name;
    if (hosted === this.#hosted) return; // most status updates are member counts: the menu stays as it is
    this.#hosted = hosted;
    this.refresh();
  }

  /** Rebuilds the tooltip and the menu, e.g. in the new language. */
  refresh(): void {
    if (!this.#tray) return;
    const locale = this.#deps.locale();
    const handlers: Record<TrayAction, () => void> = { open: () => this.#deps.onOpen(), quit: () => this.#deps.onQuit() };
    const template = trayMenuItems(locale, this.#hosted !== null).map(
      (item): MenuItemConstructorOptions => (item.type === 'separator' ? { type: 'separator' } : { label: item.label, click: handlers[item.action] }),
    );
    this.#tray.setToolTip(trayTooltip(locale, this.#hosted));
    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /** The first time ever the window hides: where the app went, and how to quit it. */
  notifyKeptRunning(): void {
    const content = trayText(this.#deps.locale(), 'tray.notice');
    if ((this.#deps.platform ?? process.platform) === 'win32' && this.#tray) {
      this.#tray.displayBalloon({ title: APP_NAME, content, iconType: 'info' });
    } else if (Notification.isSupported()) {
      new Notification({ title: APP_NAME, body: content }).show();
    }
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}
