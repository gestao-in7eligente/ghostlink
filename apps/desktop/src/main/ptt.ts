// Global push-to-talk (spec §8.4): a system-wide keyboard hook through uiohook-napi,
// loaded and started only while push-to-talk is on, stopped when it is turned off.
// Only the bound key is ever looked at; keystrokes are never logged or forwarded.
import type { PttConfig, PttStatus } from '../shared/ipcTypes.js';

/** The part of uiohook-napi's `uIOhook` this module uses. */
export interface PttHook {
  on(event: 'keydown' | 'keyup', listener: (e: { keycode: number }) => void): unknown;
  removeListener(event: 'keydown' | 'keyup', listener: (e: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

/** What `import('uiohook-napi')` provides. */
export interface PttHookModule {
  uIOhook: PttHook;
  UiohookKey: Readonly<Record<string, number>>;
}

export interface PushToTalkDeps {
  platform: string;
  /** Loads the native hook; only ever called once push-to-talk is enabled. */
  load(): Promise<PttHookModule>;
  /** The bound key went down (true) or up (false). */
  emit(pressed: boolean): void;
  /** Diagnostics; never receives a key. */
  warn?(message: string): void;
}

const LEFT_MODIFIERS: Readonly<Record<string, string>> = {
  ControlLeft: 'Ctrl',
  ControlRight: 'CtrlRight',
  ShiftLeft: 'Shift',
  ShiftRight: 'ShiftRight',
  AltLeft: 'Alt',
  AltRight: 'AltRight',
  MetaLeft: 'Meta',
  MetaRight: 'MetaRight',
};

/** The non-letter, non-digit names of uiohook-napi 1.5's UiohookKey (letters and digits are added below). */
const UIOHOOK_KEY_NAMES: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...['Backspace', 'Tab', 'Enter', 'CapsLock', 'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home'],
  ...['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete'],
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...['NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide', 'NumpadEnter'],
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...['Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote'],
  ...['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight', 'NumLock', 'ScrollLock', 'PrintScreen'],
]);

/**
 * The uiohook key name of a DOM `KeyboardEvent.code` (the binding the renderer records):
 * `KeyV` → `V`, `Digit1` → `1`, `ControlLeft` → `Ctrl`; other codes (F13, Space,
 * Backquote, Numpad0…) share their name. Null for anything the hook does not know.
 */
export function uiohookKeyName(code: string): string | null {
  if (!/^[A-Z][A-Za-z0-9]{0,23}$/.test(code)) return null;
  let name = code;
  if (Object.hasOwn(LEFT_MODIFIERS, code)) name = LEFT_MODIFIERS[code]!;
  else if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5);
  else if (/^(Key|Digit)/.test(code)) return null;
  return UIOHOOK_KEY_NAMES.has(name) ? name : null;
}

/**
 * Global push-to-talk. The renderer handles the key while the window has focus; this
 * adds the key while another app (a game) has it. Windows only (spec §8.4: uiohook-napi);
 * elsewhere, for unknown keys or when the native module fails to load, configure()
 * answers `{ global: false }` and push-to-talk stays in-app.
 */
export class PushToTalk {
  readonly #deps: PushToTalkDeps;
  #module: PttHookModule | null = null;
  #running = false;
  #keycode: number | null = null;
  #pressed = false;
  #queue: Promise<unknown> = Promise.resolve();

  readonly #onDown = (e: { keycode: number }) => {
    if (e.keycode !== this.#keycode || this.#pressed) return;
    this.#pressed = true;
    this.#deps.emit(true);
  };

  readonly #onUp = (e: { keycode: number }) => {
    if (e.keycode !== this.#keycode || !this.#pressed) return;
    this.#pressed = false;
    this.#deps.emit(false);
  };

  constructor(deps: PushToTalkDeps) {
    this.#deps = deps;
  }

  /** Applies the renderer's push-to-talk setting; calls run one at a time. */
  configure(config: PttConfig): Promise<PttStatus> {
    const run = this.#queue.then(() => this.#configure(config));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Stops the hook (app quit). */
  dispose(): Promise<void> {
    const run = this.#queue.then(() => this.#stop());
    this.#queue = run.catch(() => {});
    return run;
  }

  async #configure({ enabled, code }: PttConfig): Promise<PttStatus> {
    const name = enabled && code !== null && this.#deps.platform === 'win32' ? uiohookKeyName(code) : null;
    if (name === null) {
      this.#stop();
      return { global: false };
    }
    let module: PttHookModule;
    try {
      module = this.#module ?? (await this.#deps.load());
    } catch {
      this.#deps.warn?.('global push-to-talk is unavailable: the keyboard hook did not load');
      this.#stop();
      return { global: false };
    }
    this.#module = module;
    const keycode = Object.hasOwn(module.UiohookKey, name) ? module.UiohookKey[name] : undefined;
    if (typeof keycode !== 'number') {
      this.#stop();
      return { global: false };
    }
    if (keycode !== this.#keycode) this.#release();
    this.#keycode = keycode;
    if (!this.#running) {
      module.uIOhook.on('keydown', this.#onDown);
      module.uIOhook.on('keyup', this.#onUp);
      try {
        module.uIOhook.start();
      } catch {
        this.#deps.warn?.('global push-to-talk is unavailable: the keyboard hook did not start');
        module.uIOhook.removeListener('keydown', this.#onDown);
        module.uIOhook.removeListener('keyup', this.#onUp);
        this.#keycode = null;
        return { global: false };
      }
      this.#running = true;
    }
    return { global: true };
  }

  #release(): void {
    if (!this.#pressed) return;
    this.#pressed = false;
    this.#deps.emit(false);
  }

  #stop(): void {
    this.#release();
    this.#keycode = null;
    if (!this.#running || !this.#module) return;
    this.#running = false;
    const hook = this.#module.uIOhook;
    hook.removeListener('keydown', this.#onDown);
    hook.removeListener('keyup', this.#onUp);
    try {
      hook.stop();
    } catch {
      this.#deps.warn?.('the keyboard hook did not stop cleanly');
    }
  }
}
