import { describe, expect, it } from 'vitest';
import { formatBotConnectionCode } from '@ghostlink/shared';
import { Client, DiscordjsError, parseConnectionCode } from '../src/index.js';

const PIN = 'p'.repeat(43);
const TOKEN = 'T0k3n_-'.padEnd(43, 'x');

describe('parseConnectionCode (the bot "token")', () => {
  it('reads the code the app shows, as the server formats it', () => {
    for (const host of ['203.0.113.7', 'chat.example.com', '::1']) {
      const code = formatBotConnectionCode({ host, port: 7700, serverKeyId: PIN, token: TOKEN });
      expect(parseConnectionCode(code)).toEqual({ host, port: 7700, pin: PIN, token: TOKEN });
    }
    expect(formatBotConnectionCode({ host: '::1', port: 7700, serverKeyId: PIN, token: TOKEN })).toContain('[::1]:7700');
  });

  it('tolerates the spaces and quotes of a .env line', () => {
    const code = `ghostlink-bot://chat.example.com:443?pin=${PIN}&token=${TOKEN}`;
    for (const pasted of [`  ${code}\n`, `"${code}"`, `'${code}'`]) expect(parseConnectionCode(pasted)).toMatchObject({ host: 'chat.example.com', port: 443 });
  });

  it.each([
    ['a Discord token', ['MTA5ODc2NTQzMjEwOTg3NjU0', 'GhIjKl', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.') /* a fake token, built at run time */],
    ['another scheme', `ghostlink://h:1?pin=${PIN}&token=${TOKEN}`],
    ['no token', `ghostlink-bot://h:1?pin=${PIN}`],
    ['a short token', `ghostlink-bot://h:1?pin=${PIN}&token=abc`],
    ['a bad pin', `ghostlink-bot://h:1?pin=${PIN.slice(1)}&token=${TOKEN}`],
    ['a bad port', `ghostlink-bot://h:99999?pin=${PIN}&token=${TOKEN}`],
    ['nothing', ''],
  ])('refuses %s with discord.js TokenInvalid, without echoing it', (_what, input) => {
    let error: unknown;
    try {
      parseConnectionCode(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DiscordjsError);
    expect(error).toMatchObject({ code: 'TokenInvalid' });
    if (input !== '') expect((error as Error).message).not.toContain(input);
  });

  it('is what login() takes, from GHOSTLINK_BOT when no argument is given', async () => {
    const previous = process.env.GHOSTLINK_BOT;
    process.env.GHOSTLINK_BOT = 'not a code';
    try {
      const client = new Client();
      expect(Object.keys(client)).not.toContain('token');
      await expect(client.login()).rejects.toMatchObject({ code: 'TokenInvalid' });
      await expect(new Client().login(undefined as unknown as string)).rejects.toMatchObject({ code: 'TokenInvalid' });
    } finally {
      if (previous === undefined) delete process.env.GHOSTLINK_BOT;
      else process.env.GHOSTLINK_BOT = previous;
    }
  });
});
