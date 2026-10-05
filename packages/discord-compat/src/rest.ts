/**
 * REST and Routes as the discord.js guide uses them to deploy slash commands:
 *
 *   const rest = new REST().setToken(token);
 *   await rest.put(Routes.applicationCommands(clientId), { body: commands });
 *
 * GhostLink has no HTTP API for bots: `put` on the command routes becomes `commands.set` over the
 * bot's connection (the logged-in Client's, when there is one in this process, otherwise a short
 * session of its own). Other routes throw GhostLinkUnsupported.
 */
import { botCommandSchemaClient, type BotCommand } from '@ghostlink/shared';
import { parseConnectionCode } from './connectionCode.js';
import { toDiscordCommand, toGhostLinkCommand, type APIApplicationCommand } from './commands.js';
import { DiscordjsError, GhostLinkUnsupported } from './errors.js';
import { Gateway } from './gateway.js';

/** A bot session REST can use: a logged-in Client's, or one of its own. @internal */
export interface BotSession {
  request<T>(t: string, d?: unknown): Promise<T>;
  selfId(): string;
  /** The bot's commands as GhostLink has them. */
  commands(): BotCommand[];
}

/** The logged-in clients of this process by connection token, so REST reuses their session. @internal */
export const liveSessions = new Map<string, BotSession>();

const COMMAND_ROUTE = /^\/applications\/([^/]+)\/(?:guilds\/[^/]+\/)?commands$/;

const ROUTES = {
  /** `/applications/{id}/commands`: the bot's slash commands. */
  applicationCommands(applicationId: string): `/applications/${string}/commands` {
    return `/applications/${applicationId}/commands`;
  },
  /** The same commands on GhostLink: a bot belongs to one server. */
  applicationGuildCommands(applicationId: string, guildId: string): `/applications/${string}/guilds/${string}/commands` {
    return `/applications/${applicationId}/guilds/${guildId}/commands`;
  },
};

/** discord.js's Routes, for the two command routes; any other route throws GhostLinkUnsupported. */
export const Routes: typeof ROUTES = new Proxy(ROUTES, {
  get(target, property, receiver) {
    if (typeof property === 'symbol' || property in target || property === 'then' || property === 'toJSON') return Reflect.get(target, property, receiver);
    throw new GhostLinkUnsupported(`Routes.${property}`);
  },
});

export interface RequestData {
  body?: unknown;
}

/** discord.js's REST (@discordjs/rest), for deploying slash commands. */
export class REST {
  #token: string | null = null;

  /** Options (`{ version: '10' }`…) are accepted and ignored. */
  constructor(_options?: unknown) {}

  /** The bot's connection code. */
  setToken(token: string): this {
    this.#token = token;
    return this;
  }

  /** `put(Routes.applicationCommands(id), { body })`: replaces the bot's commands. */
  async put(route: string, options: RequestData = {}): Promise<APIApplicationCommand[]> {
    if (!COMMAND_ROUTE.test(route)) throw new GhostLinkUnsupported(`REST.put ${route}`);
    if (!Array.isArray(options.body)) throw new TypeError('REST.put: body must be the list of commands');
    const commands = options.body.map((c: unknown) => toGhostLinkCommand(c));
    return this.#withSession(async (session) => {
      const res = await session.request<{ commands?: unknown[] }>('commands.set', { commands });
      return parseCommands(res.commands).map((c) => toDiscordCommand(c, session.selfId()));
    });
  }

  /** `get(Routes.applicationCommands(id))`: the bot's commands. */
  async get(route: string): Promise<APIApplicationCommand[]> {
    if (!COMMAND_ROUTE.test(route)) throw new GhostLinkUnsupported(`REST.get ${route}`);
    return this.#withSession(async (session) => session.commands().map((c) => toDiscordCommand(c, session.selfId())));
  }

  post(route: string): Promise<never> {
    return Promise.reject(new GhostLinkUnsupported(`REST.post ${route}`));
  }

  patch(route: string): Promise<never> {
    return Promise.reject(new GhostLinkUnsupported(`REST.patch ${route}`));
  }

  delete(route: string): Promise<never> {
    return Promise.reject(new GhostLinkUnsupported(`REST.delete ${route}`));
  }

  async #withSession<T>(fn: (session: BotSession) => Promise<T>): Promise<T> {
    if (this.#token === null) throw new DiscordjsError('TokenMissing');
    const code = parseConnectionCode(this.#token);
    const live = liveSessions.get(code.token);
    // A second session with the same code would take the logged-in client's place.
    if (live) return fn(live);
    const gateway = new Gateway(code, { reconnect: false });
    try {
      const welcome = await gateway.connect();
      const selfId = String((welcome.self as { userId?: unknown } | undefined)?.userId ?? '');
      const own = (Array.isArray(welcome.botCommands) ? welcome.botCommands : []).find((b: { botId?: unknown }) => b?.botId === selfId);
      return await fn({ request: (t, d) => gateway.request(t, d), selfId: () => selfId, commands: () => parseCommands(own?.commands) });
    } finally {
      gateway.close();
    }
  }
}

function parseCommands(list: unknown): BotCommand[] {
  return (Array.isArray(list) ? list : []).flatMap((c) => {
    const parsed = botCommandSchemaClient.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}
