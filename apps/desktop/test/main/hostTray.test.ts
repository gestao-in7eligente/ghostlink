import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../../src/shared/hostTypes.js';

const electron = vi.hoisted(() => {
  const trays: Array<{ tooltip: string; menu: { items: Array<{ label: string; click?: () => void }> } | null; destroyed: boolean; balloons: unknown[]; handlers: Record<string, () => void> }> = [];
  class Tray {
    state = { tooltip: '', menu: null as null | { items: Array<{ label: string; click?: () => void }> }, destroyed: false, balloons: [] as unknown[], handlers: {} as Record<string, () => void> };
    constructor() {
      trays.push(this.state);
    }
    setToolTip(t: string) {
      this.state.tooltip = t;
    }
    setContextMenu(m: { items: Array<{ label: string; click?: () => void }> }) {
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
    Menu: { buildFromTemplate: (items: Array<{ label: string; click?: () => void }>) => ({ items }) },
    nativeImage: { createFromBitmap: vi.fn(() => image) },
    Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  };
});
vi.mock('electron', () => electron);

const { HostTray, TRAY_BLURPLE, renderTrayIcon, shouldHideOnClose, trayText } = await import('../../src/main/hostTray.js');

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
    joinError: null,
    invite: null,
    startedAt: null,
  };
}

beforeEach(() => {
  electron.trays.length = 0;
});

describe('shouldHideOnClose (spec §9)', () => {
  it('keeps the app in the tray only while hosting and not quitting', () => {
    expect(shouldHideOnClose({ hosting: true, quitting: false })).toBe(true);
    expect(shouldHideOnClose({ hosting: true, quitting: true })).toBe(false);
    expect(shouldHideOnClose({ hosting: false, quitting: false })).toBe(false);
  });
});

describe('trayText', () => {
  it('speaks both languages and fills placeholders', () => {
    expect(trayText('pt-BR', 'host.tray.stopAndQuit')).toBe('Parar servidor e sair');
    expect(trayText('en', 'host.tray.stopAndQuit')).toBe('Stop server and quit');
    expect(trayText('en', 'host.tray.tooltip', { name: 'Casa' })).toBe('GhostLink — hosting Casa');
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

describe('HostTray', () => {
  function make(locale: 'pt-BR' | 'en' = 'pt-BR') {
    const calls = { open: 0, quit: 0 };
    const tray = new HostTray({ locale: () => locale, onOpen: () => calls.open++, onStopAndQuit: () => calls.quit++, platform: 'win32' });
    return { tray, calls };
  }

  it('appears while hosting with Abrir / Parar servidor e sair, and goes away when stopped', () => {
    const { tray, calls } = make();
    tray.update(status('stopped'));
    expect(electron.trays).toHaveLength(0);

    tray.update(status('starting'));
    tray.update(status('running'));
    expect(electron.trays).toHaveLength(1);
    const t = electron.trays[0]!;
    expect(t.tooltip).toBe('GhostLink — hospedando Casa do Zé');
    expect(t.menu!.items.map((i) => i.label)).toEqual(['Abrir GhostLink', 'Parar servidor e sair']);
    t.menu!.items[0]!.click!();
    t.menu!.items[1]!.click!();
    t.handlers.click!();
    expect(calls).toEqual({ open: 2, quit: 1 });

    tray.update(status('stopped'));
    expect(t.destroyed).toBe(true);
  });

  it('stays while the server failed, so the app can still be reopened', () => {
    const { tray } = make('en');
    tray.update(status('failed'));
    expect(electron.trays).toHaveLength(1);
    expect(electron.trays[0]!.menu!.items.map((i) => i.label)).toEqual(['Open GhostLink', 'Stop server and quit']);
  });

  it('shows the first-close notice as a balloon on Windows', () => {
    const { tray } = make();
    tray.update(status('running'));
    tray.notifyKeptRunning();
    expect(electron.trays[0]!.balloons).toEqual([
      expect.objectContaining({ title: 'O GhostLink continua aberto', content: expect.stringContaining('Parar servidor e sair') }),
    ]);
  });
});
