import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PushToTalk, uiohookKeyName, type PttHookModule } from '../../src/main/ptt.js';

const KEYS = { V: 47, Space: 57, Ctrl: 29, CtrlRight: 3613, F13: 91, 1: 2, Backquote: 41, Numpad0: 82, AltRight: 3640 } as const;

class FakeHook extends EventEmitter {
  started = 0;
  stopped = 0;
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  press(keycode: number): void {
    this.emit('keydown', { keycode, type: 4, time: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  }
  release(keycode: number): void {
    this.emit('keyup', { keycode, type: 5, time: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  }
}

function setup(platform: NodeJS.Platform = 'win32', load?: () => Promise<PttHookModule>) {
  const hook = new FakeHook();
  const events: boolean[] = [];
  const warnings: string[] = [];
  const loader = vi.fn(load ?? (async () => ({ uIOhook: hook, UiohookKey: KEYS }) as unknown as PttHookModule));
  const ptt = new PushToTalk({ platform, load: loader, emit: (pressed) => events.push(pressed), warn: (m) => warnings.push(m) });
  return { hook, events, warnings, loader, ptt };
}

describe('uiohookKeyName: DOM KeyboardEvent.code → uiohook key', () => {
  it('maps letters, digits, modifiers, function and numpad keys', () => {
    expect(uiohookKeyName('KeyV')).toBe('V');
    expect(uiohookKeyName('Digit1')).toBe('1');
    expect(uiohookKeyName('ControlLeft')).toBe('Ctrl');
    expect(uiohookKeyName('ControlRight')).toBe('CtrlRight');
    expect(uiohookKeyName('AltLeft')).toBe('Alt');
    expect(uiohookKeyName('ShiftRight')).toBe('ShiftRight');
    expect(uiohookKeyName('MetaLeft')).toBe('Meta');
    expect(uiohookKeyName('F13')).toBe('F13');
    expect(uiohookKeyName('Backquote')).toBe('Backquote');
    expect(uiohookKeyName('Numpad0')).toBe('Numpad0');
    expect(uiohookKeyName('Space')).toBe('Space');
  });

  it('every key it accepts exists in the installed uiohook-napi', async () => {
    const { UiohookKey } = (await import('uiohook-napi')) as unknown as PttHookModule;
    const codes = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
      ...'0123456789'.split('').map((d) => `Digit${d}`),
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      ...['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'],
      ...['Space', 'Backquote', 'CapsLock', 'Tab', 'Numpad0', 'NumpadAdd', 'Insert', 'PageDown', 'ScrollLock', 'Quote'],
    ];
    for (const code of codes) expect(UiohookKey[uiohookKeyName(code)!], code).toBeTypeOf('number');
  });

  it('refuses anything that is not a plain key code', () => {
    for (const bad of ['', 'Key', 'KeyAB', 'Digit', 'Digit12', '__proto__', 'constructor', 'toString', 'Mouse4', 'a'.repeat(40)]) {
      expect(uiohookKeyName(bad), bad).toBeNull();
    }
  });
});

describe('PushToTalk (global push-to-talk, Windows)', () => {
  it('loads and starts the hook only once enabled, and reports only the bound key, once per press', async () => {
    const { hook, events, loader, ptt } = setup();
    expect(loader).not.toHaveBeenCalled();
    expect(await ptt.configure({ enabled: true, code: 'KeyV' })).toEqual({ global: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(hook.started).toBe(1);

    hook.press(KEYS.Space);
    hook.release(KEYS.Space);
    expect(events).toEqual([]);
    hook.press(KEYS.V);
    hook.press(KEYS.V); // key repeat while held
    hook.press(KEYS.V);
    hook.release(KEYS.V);
    expect(events).toEqual([true, false]);
  });

  it('rebinding switches keys without restarting, and releases a key held at that moment', async () => {
    const { hook, events, loader, ptt } = setup();
    await ptt.configure({ enabled: true, code: 'KeyV' });
    hook.press(KEYS.V);
    await ptt.configure({ enabled: true, code: 'ControlRight' });
    expect(events).toEqual([true, false]);
    hook.release(KEYS.V);
    hook.press(KEYS.CtrlRight);
    expect(events).toEqual([true, false, true]);
    expect(hook.started).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('disabling stops the hook and removes its listeners (it runs only while push-to-talk is on)', async () => {
    const { hook, events, ptt } = setup();
    await ptt.configure({ enabled: true, code: 'KeyV' });
    hook.press(KEYS.V);
    expect(await ptt.configure({ enabled: false, code: 'KeyV' })).toEqual({ global: false });
    expect(hook.stopped).toBe(1);
    expect(hook.listenerCount('keydown') + hook.listenerCount('keyup')).toBe(0);
    expect(events).toEqual([true, false]);
    hook.press(KEYS.V);
    expect(events).toEqual([true, false]);

    expect(await ptt.configure({ enabled: true, code: 'KeyV' })).toEqual({ global: true });
    expect(hook.started).toBe(2);
    await ptt.dispose();
    expect(hook.stopped).toBe(2);
  });

  it('stays in-app only off Windows, for unknown keys, and when the native hook cannot load', async () => {
    const mac = setup('darwin');
    expect(await mac.ptt.configure({ enabled: true, code: 'KeyV' })).toEqual({ global: false });
    expect(mac.loader).not.toHaveBeenCalled();

    const unknown = setup();
    expect(await unknown.ptt.configure({ enabled: true, code: 'Lang1' })).toEqual({ global: false });
    expect(await unknown.ptt.configure({ enabled: true, code: null })).toEqual({ global: false });
    expect(unknown.loader).not.toHaveBeenCalled();

    const broken = setup('win32', async () => {
      throw new Error('The specified module could not be found. C:\\Users\\ana\\uiohook.node');
    });
    expect(await broken.ptt.configure({ enabled: true, code: 'KeyV' })).toEqual({ global: false });
    expect(broken.warnings.join('\n')).not.toMatch(/KeyV|ana/);
  });

  it('never logs keys: nothing is written to the console while typing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { hook, ptt } = setup();
    await ptt.configure({ enabled: true, code: 'KeyV' });
    for (const k of Object.values(KEYS)) {
      hook.press(k);
      hook.release(k);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('serializes overlapping configure calls', async () => {
    const { hook, ptt } = setup();
    const results = await Promise.all([
      ptt.configure({ enabled: true, code: 'KeyV' }),
      ptt.configure({ enabled: false, code: 'KeyV' }),
      ptt.configure({ enabled: true, code: 'Space' }),
    ]);
    expect(results).toEqual([{ global: true }, { global: false }, { global: true }]);
    expect(hook.started - hook.stopped).toBe(1);
    expect(hook.listenerCount('keydown')).toBe(1);
  });
});
