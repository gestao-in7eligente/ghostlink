import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WelcomePayload } from '@ghostlink/shared';
import type { Logger } from './logger.js';
import type { ModuleContext, RequestHandler, ServerModule, SessionCloseInfo, SessionInfo } from './modules.js';

/** Keys of the M1 welcome; modules may not contribute them. `satisfies` keeps it in sync with WelcomePayload. */
const M1_WELCOME_KEYS: ReadonlySet<string> = new Set(Object.keys({
  self: true,
  sessionId: true,
  serverTime: true,
  server: true,
  features: true,
  fileToken: true,
  protocol: true,
} satisfies Record<keyof WelcomePayload, true>));

/**
 * Composes the registered modules (see modules.ts): validates names and request
 * types at construction, runs the lifecycle, merges welcome contributions and
 * fans out session hooks and HTTP/upgrade requests. Module failures in hooks and
 * routes are logged and contained so one module cannot break the others.
 */
export class ModuleHost {
  readonly handlers: Readonly<Record<string, RequestHandler>>;
  readonly features: readonly string[];
  readonly #modules: readonly ServerModule[];
  readonly #byName = new Map<string, ServerModule>();
  readonly #logger: Logger;
  readonly #initialized: ServerModule[] = [];
  #context: ModuleContext | null = null;
  #stopping: Promise<void> | null = null;

  constructor(modules: readonly ServerModule[], logger: Logger) {
    this.#modules = modules;
    this.#logger = logger;
    const owners = new Map<string, string>();
    const handlers = new Map<string, RequestHandler>();
    const features = new Set<string>();
    for (const m of modules) {
      if (typeof m.name !== 'string' || m.name.length === 0) throw new Error('every server module needs a non-empty name');
      if (this.#byName.has(m.name)) throw new Error(`duplicate module name "${m.name}"`);
      this.#byName.set(m.name, m);
      for (const [type, handler] of Object.entries(m.handlers ?? {})) {
        const owner = owners.get(type);
        if (owner !== undefined) throw new Error(`request type "${type}" is registered by both module "${owner}" and module "${m.name}"`);
        owners.set(type, m.name);
        handlers.set(type, handler);
      }
      for (const f of m.features ?? []) features.add(f);
    }
    // fromEntries defines own properties, so even "__proto__" stays a plain key.
    this.handlers = Object.freeze(Object.fromEntries(handlers));
    this.features = Object.freeze([...features]);
  }

  get context(): ModuleContext {
    if (!this.#context) throw new Error('the module context is not available before init');
    return this.#context;
  }

  getModule<T extends ServerModule = ServerModule>(name: string): T {
    const m = this.#byName.get(name);
    if (!m) throw new Error(`unknown module "${name}"`);
    return m as T;
  }

  /** Runs every init() in order. On failure the caller runs stop(), which stops only the modules that initialized. */
  async init(base: Omit<ModuleContext, 'getModule'>): Promise<void> {
    const context: ModuleContext = { ...base, getModule: (name) => this.getModule(name) };
    this.#context = context;
    for (const m of this.#modules) {
      await m.init?.(context);
      this.#initialized.push(m);
    }
  }

  async start(info: { port: number }): Promise<void> {
    for (const m of this.#initialized) await m.start?.(info);
  }

  /** Stops the initialized modules in reverse order. Idempotent; a failing stop() is logged and skipped. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      for (const m of [...this.#initialized].reverse()) {
        try {
          await m.stop?.();
        } catch (e) {
          this.#logger.error('module stop failed', { module: m.name, error: String(e) });
        }
      }
    })();
    return this.#stopping;
  }

  /** Extra welcome fields for this session. Throws when a key is an M1 key or comes from two modules. */
  welcome(session: SessionInfo): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const owners = new Map<string, string>();
    for (const m of this.#modules) {
      if (!m.welcome) continue;
      const extra: unknown = m.welcome(session);
      if (typeof extra !== 'object' || extra === null || extra instanceof Promise) {
        throw new Error(`module "${m.name}" welcome() must synchronously return an object`);
      }
      for (const [key, value] of Object.entries(extra)) {
        if (M1_WELCOME_KEYS.has(key)) throw new Error(`module "${m.name}" may not set the M1 welcome key "${key}"`);
        const owner = owners.get(key);
        if (owner !== undefined) throw new Error(`welcome key "${key}" is set by both module "${owner}" and module "${m.name}"`);
        owners.set(key, m.name);
        Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    return merged;
  }

  sessionOpened(session: SessionInfo): void {
    for (const m of this.#modules) {
      if (m.onSessionOpened) this.#hook(m, 'onSessionOpened', () => m.onSessionOpened!(session));
    }
  }

  sessionClosed(session: SessionInfo, info: SessionCloseInfo): void {
    for (const m of this.#modules) {
      if (m.onSessionClosed) this.#hook(m, 'onSessionClosed', () => m.onSessionClosed!(session, { ...info }));
    }
  }

  /** Offers an HTTP request to the modules in order; false when none took it. */
  http(req: IncomingMessage, res: ServerResponse): boolean {
    for (const m of this.#modules) {
      if (!m.http) continue;
      try {
        if (m.http(req, res)) return true;
      } catch (e) {
        this.#logger.error('module http handler failed', { module: m.name, error: String(e) });
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': 0 });
        res.end();
        return true;
      }
    }
    return false;
  }

  /** Offers a non-/ws upgrade to the modules in order; false when none took it. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    for (const m of this.#modules) {
      if (!m.upgrade) continue;
      try {
        if (m.upgrade(req, socket, head)) return true;
      } catch (e) {
        this.#logger.error('module upgrade handler failed', { module: m.name, error: String(e) });
        socket.destroy();
        return true;
      }
    }
    return false;
  }

  #hook(m: ServerModule, hook: string, run: () => unknown): void {
    if (this.#stopping) return;
    const fail = (e: unknown) => this.#logger.error('module hook failed', { module: m.name, hook, error: String(e) });
    try {
      const result = run();
      if (result instanceof Promise) result.catch(fail);
    } catch (e) {
      fail(e);
    }
  }
}
