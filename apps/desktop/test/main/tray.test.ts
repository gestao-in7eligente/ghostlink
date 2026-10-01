import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../../src/shared/hostTypes.js';

const electron = vi.hoisted(() => {
  const trays: Array<{ tooltip: string; menu: { items: Array<{ label?: string; click?: () => void }> } | null; destroyed: boolean; balloons: unknown[]; handlers: Record<string, () => void> }> = [];
  class Tray {
    state = { tooltip: '', menu: null as null | { items: Array<{ label?: string; click?: () => void }> }, destroyed: false, balloons: [] as unknown[], handlers: {} as Record<string, () => void> };
    constructor() {
      trays.push(this.state);
    }
    setToolTip(t: string) {
      this.state.tooltip = t;
    }
    setContextMenu(m: { items: Array<{ label?: string; click?: () => void }> }) {
      this.state.menu = m;
    }
    on(event: string, handler: () => void) {
      this.state.handlers[event] = handler;
    }
    displayBalloon(options: unknown) {
      this.state.balloons.push(options);
    }
    destroy() {
      this.state.destroyed = true;
    }
    isDestroyed() {
      return this.state.destroyed;
    }
  }
  const image = { addRepresentation: vi.fn(), isEmpty: () => false };
  return {
    trays,
    Tray,
    Menu: { buildFromTemplate: (items: Array<{ label?: string; click?: () => void }>) => ({ items }) },
    nativeImage: { createFromBitmap: vi.fn(() => image) },
    Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  };
});
vi.mock('electron', () => electron);

const { AppTray, TRAY_BLURPLE, renderTrayIcon, shouldHideOnClose, trayMenuItems, trayText, trayTooltip } = await import('../../src/main/tray.js');

function status(state: HostStatus['state'], name = 'Casa do Zé'): HostStatus {
  return {
    revision: 1,
    state,
    config: { name, port: 7700, joinMode: 'invite', maxMembers: 100 },
    port: 7700,
    serverKeyId: null,
    fingerprint: null,
    addresses: [],
    members: null,
    maxMembers: null,
    hasOwner: null,
    error: null,
    errorPort: null,
    suggestedPort: null,
    network: null,
    busyMediaPorts: [],
    joinError: null,
    invite: null,
    startedAt: null,
  };
}

beforeEach(() => {
  electron.trays.length = 0;
});

describe('shouldHideOnClose (v0.3.2)', () => {
  it.each([
    // closeToTray, hosting, quitting → hide
    [true, false, false, true],
    [true, true, false, true],
    [false, true, false, true], // hosting keeps the app in the tray even with the setting off
    [false, false, false, false],
    [true, false, true, false], // quitting (Sair, app.quit()) always closes
    [true, true, true, false],
    [false, true, true, false],
  ])('closeToTray %s, hosting %s, quitting %s → hide %s', (closeToTray, hosting, quitting, hide) => {
    expect(shouldHideOnClose({ closeToTray, hosting, quitting })).toBe(hide);
  });
});

describe('trayMenuItems', () => {
  const labels = (items: ReturnType<typeof trayMenuItems>) => items.map((i) => (i.type === 'separator' ? '—' : `${i.label} (${i.action})`));

  it('opens and quits, in both languages', () => {
    expect(labels(trayMenuItems('pt-BR', false))).toEqual(['Abrir GhostLink (open)', '—', 'Sair do GhostLink (quit)']);
    expect(labels(trayMenuItems('en', false))).toEqual(['Open GhostLink (open)', '—', 'Quit GhostLink (quit)']);
  });

  it('adds the hosting entry between them while a server is hosted here', () => {
    expect(labels(trayMenuItems('pt-BR', true))).toEqual(['Abrir GhostLink (open)', '—', 'Parar servidor e sair (quit)', '—', 'Sair do GhostLink (quit)']);
  });
});

describe('trayText and trayTooltip', () => {
  it('speak both languages and fill placeholders', () => {
    expect(trayText('pt-BR', 'host.tray.stopAndQuit')).toBe('Parar servidor e sair');
    expect(trayText('en', 'tray.notice')).toBe('GhostLink is still running in the tray. To quit, use the icon near the clock.');
    expect(trayTooltip('pt-BR', null)).toBe('GhostLink');
    expect(trayTooltip('en', 'Casa')).toBe('GhostLink — hosting Casa');
  });
});

describe('renderTrayIcon', () => {
  it.each([16, 32])('draws a %ipx ghost on a rounded blurple square (premultiplied BGRA)', (size) => {
    const px = renderTrayIcon(size);
    expect(px).toHaveLength(size * size * 4);
    const at = (x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(at(0, 0)[3]).toBe(0); // rounded corner: transparent
    const [b, g, r, a] = at(1, Math.floor(size / 2)); // left edge, middle: background
    expect([b, g, r, a]).toEqual([TRAY_BLURPLE.b, TRAY_BLURPLE.g, TRAY_BLURPLE.r, 255]);
    const [cb, cg, cr] = at(Math.floor(size / 2), Math.floor(size * 0.62)); // the ghost's body: white
    expect(Math.min(cb!, cg!, cr!)).toBeGreaterThan(230);
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) expect(px[i + c]!).toBeLessThanOrEqual(px[i + 3]!); // premultiplied
    }
  });
});

describe('AppTray', () => {
  function make(locale: { current: 'pt-BR' | 'en' } = { current: 'pt-BR' }) {
    const calls = { open: 0, quit: 0 };
    const tray = new AppTray({ locale: () => locale.current, onOpen: () => calls.open++, onQuit: () => calls.quit++, platform: 'win32' });
    return { tray, calls };
  }
  const labels = (i = 0) => electron.trays[i]!.menu!.items.map((item) => item.label ?? '—');

  it('is there from show() on, not only while hosting: a click opens, the menu opens or quits', () => {
    const { tray, calls } = make();
    expect(electron.trays).toHaveLength(0);
    tray.show();
    tray.show();
    expect(electron.trays).toHaveLength(1);
    const t = electron.trays[0]!;
    expect(t.tooltip).toBe('GhostLink');
    expect(labels()).toEqual(['Abrir GhostLink', '—', 'Sair do GhostLink']);
    t.handlers.click!();
    t.menu!.items[0]!.click!();
    t.menu!.items[2]!.click!();
    expect(calls).toEqual({ open: 2, quit: 1 });
  });

  it('shows the hosting entry while a server is hosted (a failed one too), and stays when it stops', () => {
    const { tray, calls } = make();
    tray.show();
    tray.setHost(status('running'));
    const t = electron.trays[0]!;
    expect(t.tooltip).toBe('GhostLink — hospedando Casa do Zé');
    expect(labels()).toEqual(['Abrir GhostLink', '—', 'Parar servidor e sair', '—', 'Sair do GhostLink']);
    t.menu!.items[2]!.click!();
    expect(calls.quit).toBe(1);
    tray.setHost(status('failed'));
    expect(labels()).toHaveLength(5);
    tray.setHost(status('stopped'));
    expect(t.destroyed).toBe(false);
    expect(t.tooltip).toBe('GhostLink');
    expect(labels()).toEqual(['Abrir GhostLink', '—', 'Sair do GhostLink']);
  });

  it('follows the language on refresh()', () => {
    const locale = { current: 'pt-BR' as 'pt-BR' | 'en' };
    const { tray } = make(locale);
    tray.show();
    locale.current = 'en';
    tray.refresh();
    expect(labels()).toEqual(['Open GhostLink', '—', 'Quit GhostLink']);
  });

  it('shows the first-hide notice as a balloon on Windows', () => {
    const { tray } = make();
    tray.show();
    tray.notifyKeptRunning();
    expect(electron.trays[0]!.balloons).toEqual([
      expect.objectContaining({ title: 'GhostLink', content: 'O GhostLink continua rodando na bandeja. Para sair, use o ícone perto do relógio.' }),
    ]);
  });
});
