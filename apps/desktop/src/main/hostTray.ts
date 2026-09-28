// spec §9: while a server is hosted, closing the window keeps the app in the tray
// (Windows) / menu bar (macOS), with "Abrir" and "Parar servidor e sair".
import { Menu, Notification, Tray, nativeImage, type NativeImage } from 'electron';
import type { HostStatus } from '../shared/hostTypes.js';
import type { Locale } from '../shared/ipcTypes.js';
import { host as en } from '../renderer/i18n/en/host.js';
import { host as ptBR } from '../renderer/i18n/pt-BR/host.js';

type TrayKey = Extract<keyof typeof ptBR, `host.tray.${string}`>;

/** The tray texts come from the renderer's host namespace (pure data), so both stay in one place. */
export function trayText(locale: Locale, key: TrayKey, vars: Readonly<Record<string, string>> = {}): string {
  const template = (locale === 'pt-BR' ? ptBR : en)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : match));
}

/** True when closing the window should hide it instead (hosting, and not already quitting). */
export function shouldHideOnClose(s: { hosting: boolean; quitting: boolean }): boolean {
  return s.hosting && !s.quitting;
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

function trayImage(): NativeImage {
  const image = nativeImage.createFromBitmap(renderTrayIcon(16), { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: renderTrayIcon(32) });
  return image;
}

export interface HostTrayDeps {
  locale(): Locale;
  onOpen(): void;
  onStopAndQuit(): void;
  platform?: NodeJS.Platform;
}

/** Shown while a server is hosted (or failed, so the hidden window can be reopened); gone when stopped. */
export class HostTray {
  readonly #deps: HostTrayDeps;
  #tray: Tray | null = null;

  constructor(deps: HostTrayDeps) {
    this.#deps = deps;
  }

  update(status: HostStatus): void {
    if (status.state === 'stopped' || status.config === null) {
      this.destroy();
      return;
    }
    const locale = this.#deps.locale();
    if (!this.#tray) {
      this.#tray = new Tray(trayImage());
      this.#tray.on('click', () => this.#deps.onOpen());
    }
    this.#tray.setToolTip(trayText(locale, 'host.tray.tooltip', { name: status.config.name }));
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: trayText(locale, 'host.tray.open'), click: () => this.#deps.onOpen() },
        { label: trayText(locale, 'host.tray.stopAndQuit'), click: () => this.#deps.onStopAndQuit() },
      ]),
    );
  }

  /** The first time the window is closed while hosting (spec §9: "Na primeira vez, o app avisa"). */
  notifyKeptRunning(): void {
    const locale = this.#deps.locale();
    const title = trayText(locale, 'host.tray.noticeTitle');
    const content = trayText(locale, 'host.tray.noticeBody');
    if ((this.#deps.platform ?? process.platform) === 'win32' && this.#tray) {
      this.#tray.displayBalloon({ title, content, iconType: 'info' });
    } else if (Notification.isSupported()) {
      new Notification({ title, body: content }).show();
    }
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}
