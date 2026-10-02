import { parseBotConnectionCode } from '@ghostlink/shared';
import { DiscordjsError } from './errors.js';

/** A parsed `ghostlink-bot://<host:port>?pin=<serverKeyId>&token=<secret>` (bots spec §1). */
export interface ConnectionCode {
  host: string;
  port: number;
  /** The server's TLS key pin: the connection is refused when the certificate's key differs. */
  pin: string;
  /** The secret sent in the bot's hello. Never log it. */
  token: string;
}

/**
 * Reads the connection code the app shows when a bot is created, the bot's "token". Surrounding
 * spaces and quotes (as pasted into a .env file) are tolerated; anything else that is not a
 * code throws discord.js's TokenInvalid error, without echoing the input.
 */
export function parseConnectionCode(input: unknown): ConnectionCode {
  if (typeof input !== 'string') throw new DiscordjsError('TokenInvalid');
  const unquoted = input.trim().replace(/^(['"])(.*)\1$/s, '$2');
  const code = parseBotConnectionCode(unquoted);
  if (code === null) throw new DiscordjsError('TokenInvalid');
  return { host: code.host, port: code.port, pin: code.serverKeyId, token: code.token };
}
