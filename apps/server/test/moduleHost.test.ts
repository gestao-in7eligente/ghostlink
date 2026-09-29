import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database.js';
import { resolveLimits } from '../src/limits.js';
import type { Logger } from '../src/logger.js';
import { ModuleHost } from '../src/moduleHost.js';
import type { ModuleContext, ServerModule, SessionsApi } from '../src/modules.js';

const logger = () => ({ info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() });
const sessions: SessionsApi = {
  list: () => [],
  send: () => false,
  broadcast: () => 0,
  closeUser: () => false,
  isOnlineOrInGrace: () => false,
};
const base: Omit<ModuleContext, 'getModule'> = {
  db: {} as Db,
  now: () => 42,
  logger: logger(),
  limits: resolveLimits(),
  dataDir: '/data',
  serverKeyId: 'key',
  sessions,
};
const session = { userId: 'u1', sessionId: 's1' };

describe('ModuleHost: registration', () => {
  it('merges the handlers of every module', () => {
    const ping = () => 1;
    const send = () => 2;
    const host = new ModuleHost([{ name: 'core', handlers: { ping } }, { name: 'text', handlers: { 'msg.send': send } }], logger());
    expect(host.handlers).toEqual({ ping, 'msg.send': send });
  });

  it('refuses a request type registered by two modules, naming both', () => {
    const modules: ServerModule[] = [{ name: 'core', handlers: { ping: () => 1 } }, { name: 'voice', handlers: { ping: () => 2 } }];
    expect(() => new ModuleHost(modules, logger())).toThrow(/"ping".*"core".*"voice"/);
  });

  it('refuses duplicate and empty module names', () => {
    expect(() => new ModuleHost([{ name: 'text' }, { name: 'text' }], logger())).toThrow(/duplicate module name "text"/);
    expect(() => new ModuleHost([{ name: '' }], logger())).toThrow(/name/);
  });

  it('stores handler names safely, even prototype keys', () => {
    const odd = () => 'odd';
    const host = new ModuleHost([{ name: 'x', handlers: Object.fromEntries([['__proto__', odd]]) }], logger());
    expect(Object.hasOwn(host.handlers, '__proto__')).toBe(true);
    expect(Object.hasOwn(host.handlers, 'toString')).toBe(false);
  });

  it('merges static features in order without duplicates', () => {
    const host = new ModuleHost([{ name: 'a', features: ['chat', 'roles'] }, { name: 'b', features: ['voice', 'chat'] }], logger());
    expect(host.features).toEqual(['chat', 'roles', 'voice']);
  });
});

describe('ModuleHost: lifecycle', () => {
  function recorder(name: string, log: string[], extra: Partial<ServerModule> = {}): ServerModule {
    return {
      name,
      init: () => {
        log.push(`init:${name}`);
      },
      start: async ({ port }) => {
        log.push(`start:${name}:${port}`);
      },
      stop: async () => {
        log.push(`stop:${name}`);
      },
      ...extra,
    };
  }

  it('inits and starts in order and stops in reverse order, once', async () => {
    const log: string[] = [];
    const host = new ModuleHost(['a', 'b', 'c'].map((n) => recorder(n, log)), logger());
    await host.init(base);
    await host.start({ port: 7700 });
    await host.stop();
    await host.stop();
    expect(log).toEqual(['init:a', 'init:b', 'init:c', 'start:a:7700', 'start:b:7700', 'start:c:7700', 'stop:c', 'stop:b', 'stop:a']);
  });

  it('gives init the shared context and cross-module lookup', async () => {
    let seen: ModuleContext | undefined;
    const b: ServerModule & { hello(): string } = { name: 'b', hello: () => 'hi from b' };
    const a: ServerModule = {
      name: 'a',
      init: (ctx) => {
        seen = ctx;
      },
    };
    const host = new ModuleHost([a, b], logger());
    await host.init(base);
    expect(seen).toMatchObject({ dataDir: '/data', serverKeyId: 'key', sessions });
    expect(seen!.now()).toBe(42);
    expect(seen!.getModule<typeof b>('b').hello()).toBe('hi from b');
    expect(() => seen!.getModule('nope')).toThrow(/unknown module "nope"/);
    expect(host.context).toBe(seen);
  });

  it('context is unavailable before init', () => {
    expect(() => new ModuleHost([], logger()).context).toThrow(/before init/);
  });

  it('when an init fails, stop() only stops the modules that initialized', async () => {
    const log: string[] = [];
    const host = new ModuleHost([
      recorder('a', log),
      recorder('b', log, {
        init: () => {
          throw new Error('b broke');
        },
      }),
      recorder('c', log),
    ], logger());
    await expect(host.init(base)).rejects.toThrow('b broke');
    await host.stop();
    expect(log).toEqual(['init:a', 'stop:a']);
  });

  it('a failing stop() is logged and the others still stop', async () => {
    const log: string[] = [];
    const l = logger();
    const host = new ModuleHost([
      recorder('a', log),
      recorder('b', log, {
        stop: () => {
          throw new Error('stuck');
        },
      }),
    ], l);
    await host.init(base);
    await host.stop();
    expect(log).toEqual(['init:a', 'init:b', 'stop:a']);
    expect(l.error).toHaveBeenCalledWith('module stop failed', { module: 'b', error: 'Error: stuck' });
  });
});

describe('ModuleHost: welcome', () => {
  it('merges the per-session contributions of every module', () => {
    const host = new ModuleHost([
      { name: 'text', welcome: (s) => ({ channels: [], me: s.userId }) },
      { name: 'voice', welcome: () => ({ voice: [] }) },
      { name: 'quiet' },
    ], logger());
    expect(host.welcome(session)).toEqual({ channels: [], me: 'u1', voice: [] });
  });

  it.each(['self', 'sessionId', 'serverTime', 'server', 'features', 'fileToken', 'protocol'])('refuses the M1 key "%s"', (key) => {
    const host = new ModuleHost([{ name: 'bad', welcome: () => ({ [key]: 1 }) }], logger());
    expect(() => host.welcome(session)).toThrow(new RegExp(`module "bad".*"${key}"`));
  });

  it('refuses an async welcome() instead of silently dropping its fields', () => {
    const host = new ModuleHost([{ name: 'lazy', welcome: (async () => ({ channels: [] })) as unknown as ServerModule['welcome'] }], logger());
    expect(() => host.welcome(session)).toThrow(/module "lazy" welcome\(\) must synchronously return an object/);
  });

  it('refuses a key contributed by two modules', () => {
    const host = new ModuleHost([{ name: 'a', welcome: () => ({ voice: 1 }) }, { name: 'b', welcome: () => ({ voice: 2 }) }], logger());
    expect(() => host.welcome(session)).toThrow(/"voice".*"a".*"b"/);
  });
});

describe('ModuleHost: session hooks', () => {
  it('fans out in order and isolates failing hooks', async () => {
    const l = logger();
    const log: string[] = [];
    const host = new ModuleHost([
      {
        name: 'a',
        onSessionOpened: () => {
          throw new Error('sync boom');
        },
        onSessionClosed: (_s, i) => log.push(`a:${i.reason}:${i.graceExpired}`),
      },
      {
        name: 'b',
        onSessionOpened: async () => {
          throw new Error('async boom');
        },
      },
      { name: 'c', onSessionOpened: (s) => log.push(`c:${s.sessionId}`) },
    ], l);
    host.sessionOpened(session);
    host.sessionClosed(session, { reason: 'disconnected', graceExpired: true });
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual(['c:s1', 'a:disconnected:true']);
    expect(l.error).toHaveBeenCalledWith('module hook failed', { module: 'a', hook: 'onSessionOpened', error: 'Error: sync boom' });
    expect(l.error).toHaveBeenCalledWith('module hook failed', { module: 'b', hook: 'onSessionOpened', error: 'Error: async boom' });
  });

  it('ignores hooks once stopping', async () => {
    const opened = vi.fn();
    const host = new ModuleHost([{ name: 'a', onSessionOpened: opened, onSessionClosed: opened }], logger());
    await host.init(base);
    await host.stop();
    host.sessionOpened(session);
    host.sessionClosed(session, { reason: 'SERVER_SHUTDOWN', graceExpired: false });
    expect(opened).not.toHaveBeenCalled();
  });
});

describe('ModuleHost: http and upgrade routing', () => {
  const req = { url: '/x' } as IncomingMessage;
  function fakeRes() {
    return { headersSent: false, writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() } as unknown as ServerResponse & {
      writeHead: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
  }

  it('the first module that returns true handles the request', () => {
    const second = vi.fn(() => true);
    const third = vi.fn(() => true);
    const host = new ModuleHost([{ name: 'a', http: () => false }, { name: 'b', http: second }, { name: 'c', http: third }], logger());
    expect(host.http(req, fakeRes())).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(third).not.toHaveBeenCalled();
    expect(new ModuleHost([{ name: 'a' }], logger()).http(req, fakeRes())).toBe(false);
  });

  it('a throwing route answers 500 and is logged', () => {
    const l = logger();
    const host = new ModuleHost([{ name: 'a', http: () => {
      throw new Error('boom');
    } }], l);
    const res = fakeRes();
    expect(host.http(req, res)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Length': 0 });
    expect(l.error).toHaveBeenCalledWith('module http handler failed', { module: 'a', error: 'Error: boom' });
  });

  it('upgrades go to the first module that claims them; a throw destroys the socket', () => {
    const socket = { destroy: vi.fn() } as unknown as Duplex & { destroy: ReturnType<typeof vi.fn> };
    const head = Buffer.alloc(0);
    const claim = vi.fn(() => true);
    expect(new ModuleHost([{ name: 'a', upgrade: () => false }, { name: 'b', upgrade: claim }], logger()).upgrade(req, socket, head)).toBe(true);
    expect(claim).toHaveBeenCalledWith(req, socket, head);
    expect(new ModuleHost([{ name: 'a' }], logger()).upgrade(req, socket, head)).toBe(false);
    const failing = new ModuleHost([{ name: 'a', upgrade: () => {
      throw new Error('nope');
    } }], logger());
    expect(failing.upgrade(req, socket, head)).toBe(true);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});

describe('ModuleHost: the ICE-TCP target (proxy mode)', () => {
  it('is the first port a module offers; null when none does', () => {
    const host = new ModuleHost([{ name: 'a' }, { name: 'b', iceTcpPort: () => null }, { name: 'c', iceTcpPort: () => 25_889 }, { name: 'd', iceTcpPort: () => 1 }], logger());
    expect(host.iceTcpPort()).toBe(25_889);
    expect(new ModuleHost([{ name: 'a' }, { name: 'b', iceTcpPort: () => null }], logger()).iceTcpPort()).toBeNull();
  });

  it('a throwing module is logged and skipped', () => {
    const l = logger();
    const host = new ModuleHost([{ name: 'a', iceTcpPort: () => {
      throw new Error('boom');
    } }, { name: 'b', iceTcpPort: () => 7 }], l);
    expect(host.iceTcpPort()).toBe(7);
    expect(l.error).toHaveBeenCalledWith('module iceTcpPort failed', { module: 'a', error: 'Error: boom' });
  });
});
