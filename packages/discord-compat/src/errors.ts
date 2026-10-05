/** The guide that lists what the package covers (bots spec §4). */
export const GUIDE_URL = 'https://gestao-in7eligente.github.io/ghostlink/en/bots';

/**
 * Thrown by every discord.js API this package does not cover (bots spec §4): embeds, buttons,
 * menus, moderation, reactions, voice… A bot never fails silently on GhostLink; it fails here,
 * naming the method.
 */
export class GhostLinkUnsupported extends Error {
  /** The discord.js API that was used, e.g. "Message.react". */
  readonly method: string;

  constructor(method: string, detail?: string) {
    super(`${method} is not supported on GhostLink${detail === undefined ? '' : ` (${detail})`}. Supported API: ${GUIDE_URL}`);
    this.name = 'GhostLinkUnsupported';
    this.method = method;
  }
}

/**
 * A refusal from the GhostLink server or a connection failure, with its code: a server error code
 * (NOT_FOUND, FORBIDDEN, RATE_LIMITED, BAD_BOT_TOKEN…) or a local one (PIN_MISMATCH,
 * UNREACHABLE, TIMEOUT, CONNECTION_LOST). The counterpart of discord.js's DiscordAPIError.
 */
export class GhostLinkError extends Error {
  readonly code: string;
  /** The request that failed (`msg.send`, `interaction.respond`…), when there was one. */
  readonly method: string | null;

  constructor(code: string, message?: string, method: string | null = null) {
    super(message === undefined || message === code ? code : `${code}: ${message}`);
    this.name = 'GhostLinkError';
    this.code = code;
    this.method = method;
  }
}

const MESSAGES = {
  TokenInvalid: () =>
    'An invalid token was provided. GhostLink expects the bot\'s connection code: ghostlink-bot://host:port?pin=…&token=… (create the bot in the app, under BOTS).',
  TokenMissing: () => 'Request to use token, but token was unavailable to the client. Set GHOSTLINK_BOT to the bot\'s connection code.',
  ClientNotReady: (action: string) => `The client needs to be logged in to ${action}.`,
  InteractionAlreadyReplied: () => 'The reply to this interaction has already been sent or deferred.',
  InteractionNotReplied: () => 'The reply to this interaction has not been sent or deferred.',
  CommandInteractionOptionNotFound: (name: string) => `Required option "${name}" not found.`,
  CommandInteractionOptionType: (name: string, type: string, expected: string) => `Option "${name}" is of type: ${type}; expected ${expected}.`,
  CommandInteractionOptionEmpty: (name: string, type: string) => `Required option "${name}" is of type: ${type}; expected a non-empty value.`,
} as const;

export type DiscordjsErrorCode = keyof typeof MESSAGES;
type Args<C extends DiscordjsErrorCode> = Parameters<(typeof MESSAGES)[C]>;

/** discord.js's own errors, with the same codes (`error.code === 'InteractionAlreadyReplied'`…). */
export class DiscordjsError<C extends DiscordjsErrorCode = DiscordjsErrorCode> extends Error {
  readonly code: C;

  constructor(code: C, ...args: Args<C>) {
    super((MESSAGES[code] as (...a: Args<C>) => string)(...args));
    this.code = code;
  }

  override get name(): string {
    return `Error [${this.code}]`;
  }
}

/** discord.js's DiscordjsTypeError: the option getters throw it. */
export class DiscordjsTypeError<C extends DiscordjsErrorCode = DiscordjsErrorCode> extends TypeError {
  readonly code: C;

  constructor(code: C, ...args: Args<C>) {
    super((MESSAGES[code] as (...a: Args<C>) => string)(...args));
    this.code = code;
  }

  override get name(): string {
    return `TypeError [${this.code}]`;
  }
}

/**
 * Makes each discord.js member outside the subset throw GhostLinkUnsupported("<Owner>.<name>")
 * when it is read: `message.react('👍')` and `message.member.roles` both stop there, with the
 * method's name, instead of "undefined is not a function".
 * @internal
 */
export function unsupportedMembers(prototype: object, owner: string, names: readonly string[]): void {
  for (const name of names) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: false,
      get() {
        throw new GhostLinkUnsupported(`${owner}.${name}`);
      },
    });
  }
}

/**
 * A stand-in for a discord.js export outside the subset (EmbedBuilder, ButtonBuilder…): using it
 * throws GhostLinkUnsupported, where a missing export would be undefined.
 * @internal
 */
export function unsupportedClass(name: string): new (...args: unknown[]) => never {
  return class {
    constructor() {
      throw new GhostLinkUnsupported(name);
    }
  } as unknown as new (...args: unknown[]) => never;
}

/**
 * An object whose every property throws GhostLinkUnsupported("<name>.<property>") (for
 * PermissionFlagsBits and similar constant tables outside the subset).
 * @internal
 */
export function unsupportedTable(name: string): Readonly<Record<string, never>> {
  return new Proxy(Object.freeze({}) as Record<string, never>, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined;
      throw new GhostLinkUnsupported(`${name}.${property}`);
    },
  });
}
