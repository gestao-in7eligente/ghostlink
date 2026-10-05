import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileLog,
  LOG_FILE,
  LOG_MAX_BYTES,
  LOG_OLD_FILE,
  forwardStream,
  forwardText,
  guardStdio,
  guardStream,
  installCrashHandlers,
  isBrokenPipe,
  logLines,
  redactSecrets,
  safeWrite,
  type Log,
} from '../../src/main/log.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const at = () => new Date('2026-09-28T12:00:00.000Z');

function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** A console pipe whose reader went away: every write fails with EPIPE, like process.stdout. */
function brokenPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(codeError('EPIPE', 'write EPIPE'));
    },
  });
}

/** Collects every error that nobody handled while `run` executes. */
async function uncaughtDuring(run: () => Promise<void> | void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onError = (e: unknown) => seen.push(e);
  process.on('uncaughtException', onError);
  try {
    await run();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('uncaughtException', onError);
  }
  return seen;
}

function fakeLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m, ...d) => lines.push(['info', m, ...d.map(String)].join(' ')),
    warn: (m, ...d) => lines.push(['warn', m, ...d.map(String)].join(' ')),
    error: (m, ...d) => lines.push(['error', m, ...d.map(String)].join(' ')),
  };
}

describe('FileLog', () => {
  it('appends timestamped lines to <dir>/main.log, creating the folder', () => {
    const logs = join(dir.path, 'logs');
    const log = new FileLog({ dir: logs, now: at });
    log.info('GhostLink starting');
    log.error('it failed:', new Error('boom'));
    const text = readFileSync(join(logs, LOG_FILE), 'utf8');
    expect(text.startsWith('2026-09-28T12:00:00.000Z info GhostLink starting\n')).toBe(true);
    expect(text).toContain('2026-09-28T12:00:00.000Z error it failed: Error: boom');
    expect(log.path).toBe(join(logs, LOG_FILE));
  });

  it('rotates at the size limit, keeping exactly one old file', () => {
    const log = new FileLog({ dir: dir.path, maxBytes: 200, now: at });
    const line = (n: number) => `line ${n} ${'x'.repeat(40)}`; // 77 bytes with timestamp and level
    for (let n = 1; n <= 3; n++) log.info(line(n));
    expect(readdirSync(dir.path).sort()).toEqual([LOG_FILE, LOG_OLD_FILE]);
    expect(readFileSync(join(dir.path, LOG_OLD_FILE), 'utf8')).toContain('line 2');
    expect(readFileSync(join(dir.path, LOG_FILE), 'utf8')).toContain('line 3');
    for (let n = 4; n <= 7; n++) log.info(line(n));
    expect(readdirSync(dir.path).sort()).toEqual([LOG_FILE, LOG_OLD_FILE]);
    const old = readFileSync(join(dir.path, LOG_OLD_FILE), 'utf8');
    expect(old).toContain('line 5');
    expect(old).not.toContain('line 2');
    expect(statSync(join(dir.path, LOG_FILE)).size).toBeLessThanOrEqual(200);
  });

  it('counts the size of a log left by an earlier run', () => {
    writeFileSync(join(dir.path, LOG_FILE), 'y'.repeat(190));
    new FileLog({ dir: dir.path, maxBytes: 200, now: at }).info('next run');
    expect(readFileSync(join(dir.path, LOG_OLD_FILE), 'utf8')).toBe('y'.repeat(190));
    expect(readFileSync(join(dir.path, LOG_FILE), 'utf8')).toContain('next run');
  });

  it('defaults to a 5 MB limit', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('mirrors lines only when a mirror is given, and survives a throwing mirror', () => {
    const mirrored: string[] = [];
    new FileLog({ dir: dir.path, now: at, mirror: (line, level) => mirrored.push(`${level}|${line}`) }).warn('careful');
    expect(mirrored).toEqual(['warn|2026-09-28T12:00:00.000Z warn careful\n']);
    const log = new FileLog({ dir: dir.path, now: at, mirror: () => {
      throw new Error('console gone');
    } });
    expect(() => log.info('still fine')).not.toThrow();
  });

  it('never throws when the log file cannot be written', () => {
    const notADir = join(dir.path, 'file');
    writeFileSync(notADir, '');
    const log = new FileLog({ dir: notADir, now: at });
    expect(() => log.error('lost', new Error('x'))).not.toThrow();
  });

  it('masks secret-looking values', () => {
    const log = new FileLog({ dir: dir.path, now: at });
    log.info('join', { sessionToken: 'abc123', nickname: 'Ana', setupCode: 'K7Q2-9XZL' });
    const text = readFileSync(join(dir.path, LOG_FILE), 'utf8');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('K7Q2-9XZL');
    expect(text).toContain('Ana');
  });
});

describe('redactSecrets', () => {
  it('masks JSON and key=value secrets and leaves the rest alone', () => {
    expect(redactSecrets('{"token":"abc","nick":"ana","inviteCode":"Q\\"x"}')).toBe(
      '{"token":"[redacted]","nick":"ana","inviteCode":"[redacted]"}',
    );
    expect(redactSecrets('password=hunter2 setup_code: 1234-5678 Authorization: Bearer')).toBe(
      'password=[redacted] setup_code: [redacted] Authorization: [redacted]',
    );
    expect(redactSecrets('tokens: 5, listening on port 7700')).toBe('tokens: 5, listening on port 7700');
  });
});

describe('broken pipes', () => {
  it('knows which errors mean "the reader went away"', () => {
    expect(isBrokenPipe(codeError('EPIPE'))).toBe(true);
    expect(isBrokenPipe(codeError('ERR_STREAM_DESTROYED'))).toBe(true);
    expect(isBrokenPipe(codeError('ENOSPC'))).toBe(false);
    expect(isBrokenPipe(undefined)).toBe(false);
  });

  it('guardStream swallows EPIPE, after which the destroyed stream drops writes quietly', async () => {
    const other = vi.fn();
    const stdout = brokenPipe();
    const seen = await uncaughtDuring(async () => {
      guardStream(stdout, other);
      stdout.write('first line');
      await new Promise((r) => setTimeout(r, 10));
      expect(stdout.destroyed).toBe(true);
      expect(safeWrite(stdout, 'second line')).toBe(false);
      stdout.write('direct write after destroy'); // ERR_STREAM_DESTROYED, callback only
    });
    expect(seen).toEqual([]);
    expect(other).not.toHaveBeenCalled();
  });

  it('guardStream reports errors that are not broken pipes', () => {
    const other = vi.fn();
    const stream = new PassThrough();
    guardStream(stream, other);
    stream.emit('error', codeError('ENOSPC'));
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOSPC' }));
  });

  it('safeWrite writes to a live stream and refuses an ended or missing one', () => {
    const live = new PassThrough();
    expect(safeWrite(live, 'hi')).toBe(true);
    expect(live.read()?.toString()).toBe('hi');
    live.end();
    expect(safeWrite(live, 'late')).toBe(false);
    expect(safeWrite(null, 'nobody')).toBe(false);
  });

  it('guardStdio guards both process streams', async () => {
    const fake = { stdout: brokenPipe(), stderr: brokenPipe() };
    const log = fakeLog();
    const seen = await uncaughtDuring(() => {
      guardStdio(fake as unknown as NodeJS.Process, log);
      fake.stdout.write('a');
      fake.stderr.write('b');
    });
    expect(seen).toEqual([]);
    expect(log.lines).toEqual([]);
  });
});

describe('forwardStream / forwardText', () => {
  it('survives a destination that closes mid-stream and keeps draining the source', async () => {
    const source = new PassThrough();
    const destination = brokenPipe();
    const onError = vi.fn();
    const seen = await uncaughtDuring(async () => {
      forwardStream(source, destination, onError);
      source.write('first\n');
      await new Promise((r) => setTimeout(r, 10));
      source.write('second\n');
      source.end('third\n');
      await once(source, 'end');
    });
    expect(seen).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(destination.destroyed).toBe(true);
  });

  it('forwards to a live destination and stops at a destroyed one', async () => {
    const source = new PassThrough();
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    forwardStream(source, destination);
    source.write('one');
    await new Promise((r) => setTimeout(r, 5));
    destination.destroy();
    source.end('two');
    await once(source, 'end');
    expect(chunks).toEqual(['one']);
  });

  it('handles errors of the source stream', async () => {
    const source = new PassThrough();
    const onError = vi.fn();
    const seen = await uncaughtDuring(() => {
      forwardStream(source, new PassThrough(), onError);
      source.destroy(codeError('ECONNRESET'));
    });
    expect(seen).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ECONNRESET' }));
  });

  it('forwardText keeps reading when the consumer throws', async () => {
    const source = new PassThrough();
    const texts: string[] = [];
    const onError = vi.fn();
    forwardText(source, (text) => {
      texts.push(text);
      if (texts.length === 1) throw new Error('consumer bug');
    }, onError);
    source.write('a');
    await new Promise((r) => setTimeout(r, 5));
    source.end('b');
    await once(source, 'end');
    expect(texts).toEqual(['a', 'b']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('logLines writes one entry per non-empty line', () => {
    const log = fakeLog();
    logLines(log, '[server]', '2026 info listening\r\n\nsecond\n', 'warn');
    expect(log.lines).toEqual(['warn [server] 2026 info listening', 'warn [server] second']);
  });
});

describe('installCrashHandlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs uncaught exceptions and rejections and keeps the app running', () => {
    const target = new EventEmitter();
    const log = fakeLog();
    const exit = vi.fn();
    installCrashHandlers({ log, smoke: false, exit, target: target as unknown as NodeJS.Process });
    target.emit('uncaughtException', new Error('write EPIPE'));
    target.emit('unhandledRejection', new Error('nobody awaited me'));
    expect(log.lines).toEqual([
      'error uncaught exception: Error: write EPIPE',
      'error unhandled promise rejection: Error: nobody awaited me',
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails a smoke run with exit code 1', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installCrashHandlers({ log: fakeLog(), smoke: true, exit, target: target as unknown as NodeJS.Process });
    target.emit('unhandledRejection', 'plain reason');
    target.emit('uncaughtException', new Error('boom'));
    expect(exit.mock.calls).toEqual([[1], [1]]);
  });

  it('writes the file log, not a dialog, for a real main-process crash handler setup', () => {
    const target = new EventEmitter();
    const log = new FileLog({ dir: dir.path, now: at });
    installCrashHandlers({ log, smoke: false, exit: vi.fn(), target: target as unknown as NodeJS.Process });
    target.emit('uncaughtException', codeError('EPIPE', 'write EPIPE'));
    expect(existsSync(log.path)).toBe(true);
    expect(readFileSync(log.path, 'utf8')).toContain('error uncaught exception: Error: write EPIPE');
  });
});
