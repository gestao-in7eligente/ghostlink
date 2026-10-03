import { PROTOCOL, parseBotConnectionCode, type ErrorCode } from '@ghostlink/shared';
import { wrapClient, type TextClient, type TextFixture } from '../text/helpers.js';
import { connectRaw } from './testClient.js';

/** A bot's handshake with its connection code (as in bots.test.ts): its client, or the refusal. */
export async function connectBot(fx: TextFixture, code: string): Promise<{ client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode }> {
  const parsed = parseBotConnectionCode(code)!;
  const raw = await connectRaw(fx.t.server, { pin: parsed.serverKeyId });
  raw.send({ t: 'hello', d: { protocol: PROTOCOL.current, bot: parsed.token, client: 'hermes-test/0.0.0' } });
  const m = await raw.next();
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  const welcome = m.d as { self: { userId: string; nickname: string } } & Record<string, unknown>;
  return { client: wrapClient(raw, welcome, { userId: welcome.self.userId, seed: new Uint8Array(32), nickname: welcome.self.nickname }) };
}
