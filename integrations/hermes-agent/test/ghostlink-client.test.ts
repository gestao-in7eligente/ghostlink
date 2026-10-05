// The Hermes Agent plugin's protocol client (ghostlink/client.py) against a real GhostLink server:
// the pinned connection, the bot hello, events, requests and a refused pin. Skipped where Python
// with aiohttp and cryptography is missing (GHOSTLINK_TEST_PYTHON picks the interpreter).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotCreateResult, Message as WireMessage } from '@ghostlink/shared';
import { createAvatarsModule } from '../../../apps/server/src/avatars/index.js';
import { createBotsModule } from '../../../apps/server/src/bots/index.js';
import { channelId, nextClientMsgId, textFixture } from '../../../apps/server/test/text/helpers.js';

const SCRIPT = fileURLToPath(new URL('./client_check.py', import.meta.url));

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    const probe = spawnSync(python, ['-c', 'import aiohttp, cryptography'], { stdio: 'ignore' });
    if (probe.status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Runs client_check.py; `next()` resolves with its next JSON line. */
function run(code: string, mode = 'chat') {
  const child = spawn(PYTHON!, [SCRIPT], { env: { ...process.env, GHOSTLINK_BOT: code, GL_MODE: mode, PYTHONUNBUFFERED: '1' } });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async next(): Promise<Record<string, unknown>> {
      const line = await lines.next();
      if (line.done) throw new Error(`client_check.py ended early:\n${stderr}`);
      return JSON.parse(line.value) as Record<string, unknown>;
    },
  };
}

async function setup() {
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule()] });
  const created = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Hermes' });
  return { fx, code: created.connectionToken, botId: created.bot.userId, geral: channelId(fx.owner, 'geral') };
}

describe.skipIf(PYTHON === null)('the Hermes plugin client on a GhostLink server', () => {
  it('connects pinned, gets a mention, answers in reply, edits, and reads a refusal', async () => {
    const { fx, code, botId, geral } = await setup();
    const bot = run(code);
    expect(await bot.next()).toEqual({ ready: botId, channels: ['geral'], owner: fx.owner.userId });

    await fx.owner.ok('msg.send', { channelId: geral, content: `oi <@${botId}>`, clientMsgId: nextClientMsgId() });
    const sent = await bot.next();
    const reply = await fx.owner.event<{ message: WireMessage }>('msg.new', (d) => d.message.authorId === botId);
    expect(reply.message).toMatchObject({ content: 'pong', authorBot: true, replyTo: { authorId: fx.owner.userId } });
    expect(sent).toEqual({ sent: reply.message.id, replyTo: reply.message.replyTo?.id });
    expect(await bot.next()).toEqual({ edited: 'pong (edited)' });
    await fx.owner.event<{ message: WireMessage }>('msg.updated', (d) => d.message.id === reply.message.id && d.message.content === 'pong (edited)');
    expect(await bot.next()).toEqual({ refused: 'NOT_FOUND' });
    expect(await bot.next()).toEqual({ done: true });
  });

  it('refuses a server whose key is not the pin, before sending the token', async () => {
    const { code } = await setup();
    expect(await run(code, 'wrong-pin').next()).toEqual({ error: 'PIN_MISMATCH', refused: [] });
  });

  it('tells on_refused the code the server refuses a hello or ends a session with', async () => {
    const { fx, code, botId } = await setup();
    expect(await run(code, 'bad-token').next()).toEqual({ error: 'BAD_BOT_TOKEN', refused: ['BAD_BOT_TOKEN'] });
    const bot = run(code, 'closed');
    expect(await bot.next()).toEqual({ ready: botId });
    await fx.owner.ok('bot.regenerate', { botId });
    expect(await bot.next()).toEqual({ refused: ['BAD_BOT_TOKEN'], fatal: 'BAD_BOT_TOKEN' });
  });
});
