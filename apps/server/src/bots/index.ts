import { randomBytes } from 'node:crypto';
import {
  BOT_LIMITS,
  FEATURE_BOTS,
  FEATURE_BOT_SETTINGS,
  PERMISSIONS,
  ProtocolError,
  botCommandSchemaClient,
  botCreateSchema,
  botDeleteSchema,
  botGetSchema,
  botListSchema,
  botRegenerateSchema,
  botSetDescriptionSchema,
  botUpdateSchema,
  cleanMessageContent,
  commandsSetSchema,
  formatBotConnectionCode,
  has,
  interactionEditSchema,
  interactionFollowupSchema,
  interactionInvokeSchema,
  interactionRespondSchema,
  normalizeNickname,
  parseHostPort,
  type BotCommand,
  type BotCommands,
  type BotCreateResult,
  type BotDetails,
  type BotGetResult,
  type BotInfo,
  type BotListResult,
  type BotProfile,
  type BotRegenerateResult,
  type BotSetDescriptionResult,
  type BotUpdateResult,
  type BotUpdatedEvent,
  type BotsWelcome,
  type InteractionInvokeResult,
  type InteractionResult,
} from '@ghostlink/shared';
import { z } from 'zod';
import { newBotToken } from '../auth/botAuth.js';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, RequestContext, RequestHandler, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import type { BotTextApi } from '../text/bots.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { Interactions, checkOptions } from './interactions.js';

export const BOTS_MODULE_NAME = 'bots';

export interface BotsModuleOptions {
  /** Tests only: the first-answer deadline (default BOT_LIMITS.firstResponseMs). */
  firstResponseMs?: number;
  /** Tests only: the edit / follow-up window (default BOT_LIMITS.responseWindowMs). */
  responseWindowMs?: number;
}

export interface BotsModule extends ServerModule {
  readonly name: typeof BOTS_MODULE_NAME;
}

/** Interactions in flight per bot, answered ones included (memory bound; spec §2 sets none). */
const MAX_LIVE_PER_BOT = 1_000;
const SWEEP_INTERVAL_MS = 60_000;
/** Command uses older than BOT_LIMITS.usageWindowMs go when the bot gets a new one, and at most this often for all. */
const PURGE_INTERVAL_MS = 3_600_000;
/** A host[:port] as the Host header carries it (see voice/url.ts). */
const HOST_HEADER = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

const commandsJson = z.array(botCommandSchemaClient).max(BOT_LIMITS.maxCommands);

interface State {
  ctx: ModuleContext;
  text: BotTextApi;
  textModule: TextModule;
  interactions: Interactions;
  manage: SlidingWindowLimiter;
  commandsSet: SlidingWindowLimiter;
  invokes: SlidingWindowLimiter;
  port: number;
  /** When command uses were last purged for every bot (the server's clock). */
  lastPurge: number;
}

interface BotRow {
  user_id: string;
  nickname: string;
  avatar_file_id: string | null;
  created_by: string | null;
  created_at: number;
}

interface ProfileRow {
  user_id: string;
  description: string;
  created_by: string | null;
  created_at: number;
  last_seen_at: number | null;
}

type BotDetailsRow = BotRow & ProfileRow;

const toInfo = (r: BotRow): BotInfo => ({
  userId: r.user_id,
  name: r.nickname,
  avatar: r.avatar_file_id ?? null,
  createdBy: r.created_by,
  createdAt: Number(r.created_at),
});

const toProfile = (r: ProfileRow): BotProfile => ({
  botId: r.user_id,
  description: r.description,
  createdBy: r.created_by,
  createdAt: Number(r.created_at),
  lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
});

/** Stored commands, validated when set; anything unreadable counts as none. */
function readCommands(json: string): BotCommand[] {
  try {
    const parsed = commandsJson.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Bots (spec 2026-10-02-bots-design.md §2): `bot.create` / `bot.regenerate` / `bot.delete` /
 * `bot.list` (MANAGE_SERVER), `commands.set` (bots only), `interaction.invoke` and the bot's
 * `interaction.respond` / `edit` / `followup`, the welcome's `botCommands` and the `bots` flag.
 * The bot's settings (bot page spec "Servidor", the `botSettings` flag): `bot.get` / `bot.update`
 * (MANAGE_SERVER), `bot.setDescription` (bots only), `bot.updated`, the welcome's `botProfiles`,
 * the command uses of the last 7 days and each bot's last connection.
 * The bot handshake is in auth/handshake.ts (auth/botAuth.ts). Register after the text module.
 * Connection tokens and their hashes never reach the log.
 */
export function createBotsModule(opts: BotsModuleOptions = {}): BotsModule {
  let state: State | null = null;
  let sweep: NodeJS.Timeout | null = null;

  const need = (): State => {
    if (!state) throw new Error('the bots module is not initialized');
    return state;
  };

  const requireManager = (s: State, userId: string): void => {
    if (!s.text.isMember(userId) || !has(s.textModule.serverPermissions(userId), PERMISSIONS.MANAGE_SERVER)) throw new ProtocolError('FORBIDDEN');
  };

  const botRow = (s: State, botId: string): BotRow | undefined =>
    s.ctx.db.get<BotRow>(
      `SELECT b.user_id, u.nickname, u.avatar_file_id, b.created_by, b.created_at FROM bots b JOIN users u ON u.id = b.user_id
       WHERE b.user_id = ?`,
      botId,
    );

  /**
   * Where the bot connects: the server's first public address, as invites use; else the
   * host the manager reached it at; else this machine.
   */
  const codeAddress = (s: State, requestHost: string | undefined): { host: string; port: number } => {
    const candidates = [getMeta(s.ctx.db).publicAddresses[0], requestHost && requestHost.length <= 262 && HOST_HEADER.test(requestHost) ? requestHost : undefined];
    for (const c of candidates) {
      if (!c) continue;
      try {
        return parseHostPort(c);
      } catch {
        // not a valid host[:port]: try the next one
      }
    }
    return { host: '127.0.0.1', port: s.port };
  };

  const connectionCode = (s: State, rctx: RequestContext, token: string): string =>
    formatBotConnectionCode({ ...codeAddress(s, rctx.requestHost), serverKeyId: s.ctx.serverKeyId, token });

  const allCommands = (s: State): BotCommands[] =>
    s.ctx.db
      .all<{ user_id: string; commands: string }>('SELECT user_id, commands FROM bots ORDER BY created_at, user_id')
      .map((r) => ({ botId: r.user_id, commands: readCommands(r.commands) }));

  const allProfiles = (s: State): BotProfile[] =>
    s.ctx.db
      .all<ProfileRow>('SELECT user_id, description, created_by, created_at, last_seen_at FROM bots ORDER BY created_at, user_id')
      .map(toProfile);

  const detailsRow = (s: State, botId: string): BotDetailsRow | undefined =>
    s.ctx.db.get<BotDetailsRow>(
      `SELECT b.user_id, u.nickname, u.avatar_file_id, b.created_by, b.created_at, b.description, b.last_seen_at
       FROM bots b JOIN users u ON u.id = b.user_id WHERE b.user_id = ?`,
      botId,
    );

  const toDetails = (s: State, r: BotDetailsRow): BotDetails => ({
    ...toInfo(r),
    description: r.description,
    lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    online: s.text.member(r.user_id)?.online ?? false,
  });

  /** `bot.updated` to everyone connected, with the description as stored now. */
  const announceBot = (s: State, botId: string): void => {
    const description = s.ctx.db.get<{ description: string }>('SELECT description FROM bots WHERE user_id = ?', botId)?.description ?? '';
    s.text.broadcastMembers({ t: 'bot.updated', d: { botId, description } satisfies BotUpdatedEvent });
  };

  const isBot = (s: State, userId: string): boolean => s.ctx.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;

  /** A bot's session opened or closed: "visto por último". Never fails the session. */
  const touchLastSeen = (s: State, userId: string): void => {
    try {
      if (isBot(s, userId)) s.ctx.db.run('UPDATE bots SET last_seen_at = ? WHERE user_id = ?', s.ctx.now(), userId);
    } catch (e) {
      s.ctx.logger.warn('could not record when a bot was last seen', { error: String(e) });
    }
  };

  /** One use of a command that reached the bot; the bot's uses past the window go. Never fails the invoke. */
  const recordUse = (s: State, use: { id: string; botId: string; command: string; channelId: string; userId: string }): void => {
    const now = s.ctx.now();
    try {
      s.ctx.db.tx(() => {
        s.ctx.db.run('DELETE FROM bot_command_uses WHERE bot_id = ? AND at < ?', use.botId, now - BOT_LIMITS.usageWindowMs);
        s.ctx.db.run(
          'INSERT INTO bot_command_uses (id, bot_id, command, channel_id, user_id, at) VALUES (?, ?, ?, ?, ?, ?)',
          use.id, use.botId, use.command, use.channelId, use.userId, now,
        );
      });
    } catch (e) {
      s.ctx.logger.warn('could not record a command use', { error: String(e) });
    }
  };

  /** The bot's first answer (a reply or a defer) arrived. */
  const markAnswered = (s: State, botId: string, interactionId: string): void => {
    try {
      s.ctx.db.run('UPDATE bot_command_uses SET answered = 1 WHERE id = ? AND bot_id = ? AND answered = 0', interactionId, botId);
    } catch (e) {
      s.ctx.logger.warn('could not record a command answer', { error: String(e) });
    }
  };

  /** Every bot's uses past the window, at most once per PURGE_INTERVAL_MS. */
  const purgeUses = (s: State): void => {
    const now = s.ctx.now();
    if (now - s.lastPurge < PURGE_INTERVAL_MS) return;
    s.lastPurge = now;
    try {
      s.ctx.db.run('DELETE FROM bot_command_uses WHERE at < ?', now - BOT_LIMITS.usageWindowMs);
    } catch (e) {
      s.ctx.logger.warn('could not purge old command uses', { error: String(e) });
    }
  };

  const handlers: Record<string, RequestHandler> = {
    'bot.create': (ctx, payload): BotCreateResult => {
      const p = botCreateSchema.parse(payload);
      const s = need();
      requireManager(s, ctx.userId);
      const nick = normalizeNickname(p.name);
      const count = Number(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bots')?.n ?? 0);
      if (count >= BOT_LIMITS.maxBots) throw new ProtocolError('BAD_REQUEST', 'too many bots');
      if (s.ctx.db.get('SELECT 1 AS x FROM users WHERE nickname_norm = ?', nick.norm)) throw new ProtocolError('NICK_TAKEN');
      if (!s.manage.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      const botId = randomBytes(16).toString('hex');
      const { token, hash } = newBotToken();
      const now = s.ctx.now();
      s.ctx.db.tx(() => {
        // No identity: a 19-byte marker that no 32-byte hello key can equal (005_bots.sql).
        s.ctx.db.run(
          `INSERT INTO users (id, public_key, nickname, nickname_norm, locale, joined_at, is_bot) VALUES (?, ?, ?, ?, NULL, ?, 1)`,
          botId, Buffer.concat([Buffer.from('bot'), randomBytes(16)]), nick.display, nick.norm, now,
        );
        s.ctx.db.run('INSERT INTO bots (user_id, name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)', botId, nick.display, hash, ctx.userId, now);
      });
      s.text.memberCreated(botId);
      return { bot: toInfo(botRow(s, botId)!), connectionToken: connectionCode(s, ctx, token) };
    },

    'bot.regenerate': (ctx, payload): BotRegenerateResult => {
      const p = botRegenerateSchema.parse(payload);
      const s = need();
      requireManager(s, ctx.userId);
      if (!botRow(s, p.botId)) throw new ProtocolError('NOT_FOUND');
      if (!s.manage.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      const { token, hash } = newBotToken();
      s.ctx.db.run('UPDATE bots SET token_hash = ? WHERE user_id = ?', hash, p.botId);
      // The old code no longer works: its session ends, and a reconnect with it is refused.
      s.ctx.sessions.closeUser(p.botId, 'BAD_BOT_TOKEN');
      return { connectionToken: connectionCode(s, ctx, token) };
    },

    'bot.delete': (ctx, payload) => {
      const p = botDeleteSchema.parse(payload);
      const s = need();
      requireManager(s, ctx.userId);
      if (!botRow(s, p.botId)) throw new ProtocolError('NOT_FOUND');
      if (!s.manage.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      // Messages stay (authorBot: true, a former member); the name is free again.
      s.text.removeMember(p.botId, () => {
        s.ctx.db.run('DELETE FROM bots WHERE user_id = ?', p.botId);
        s.ctx.db.run(
          `UPDATE users SET removed_at = COALESCE(removed_at, ?), rejoin_blocked_until = NULL, last_ip = NULL, nickname_norm = ?
           WHERE id = ?`,
          s.ctx.now(), `#deleted-bot:${p.botId}`, p.botId,
        );
      }, 'BAD_BOT_TOKEN');
      s.interactions.dropBot(p.botId);
      s.text.broadcastMembers({ t: 'commands.updated', d: { botId: p.botId, commands: [] } satisfies BotCommands });
      return {};
    },

    'bot.list': (ctx, payload): BotListResult => {
      botListSchema.parse(payload ?? {});
      const s = need();
      requireManager(s, ctx.userId);
      const rows = s.ctx.db.all<BotRow>(
        `SELECT b.user_id, u.nickname, u.avatar_file_id, b.created_by, b.created_at FROM bots b JOIN users u ON u.id = b.user_id
         ORDER BY b.created_at, b.user_id`,
      );
      return { bots: rows.map(toInfo) };
    },

    'bot.get': (ctx, payload): BotGetResult => {
      const p = botGetSchema.parse(payload);
      const s = need();
      requireManager(s, ctx.userId);
      const row = detailsRow(s, p.botId);
      if (!row) throw new ProtocolError('NOT_FOUND');
      const now = s.ctx.now();
      const since = now - BOT_LIMITS.usageWindowMs;
      // Channels hidden from the requester stay hidden here too, interactions in them included.
      const channels = s.text.textChannelsFor(ctx.userId, p.botId);
      const usage = s.ctx.db
        .all<{ command: string; n: number }>(
          'SELECT command, COUNT(*) AS n FROM bot_command_uses WHERE bot_id = ? AND at >= ? GROUP BY command ORDER BY n DESC, command',
          p.botId, since,
        )
        .map((r) => ({ command: r.command, count: Number(r.n) }));
      const recent = s.ctx.db
        .all<{ user_id: string; command: string; channel_id: string; at: number; answered: number }>(
          `SELECT user_id, command, channel_id, at, answered FROM bot_command_uses
           WHERE bot_id = ? AND at >= ? AND channel_id IN (SELECT value FROM json_each(?))
           ORDER BY at DESC, rowid DESC LIMIT ?`,
          p.botId, since, JSON.stringify(channels.map((c) => c.channelId)), BOT_LIMITS.recentUses,
        )
        .map((r) => ({ userId: r.user_id, command: r.command, channelId: r.channel_id, at: Number(r.at), answered: r.answered === 1 }));
      const messages = s.ctx.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND deleted_at IS NULL AND created_at >= ?',
        p.botId, now - BOT_LIMITS.messagesWindowMs,
      );
      return {
        bot: toDetails(s, row),
        usage,
        recent,
        messagesLast24h: Number(messages?.n ?? 0),
        channels: channels.map((c) => ({ channelId: c.channelId, view: has(c.bits, PERMISSIONS.VIEW_CHANNEL), send: has(c.bits, PERMISSIONS.SEND_MESSAGES) })),
      };
    },

    'bot.update': (ctx, payload): BotUpdateResult => {
      const p = botUpdateSchema.parse(payload);
      const s = need();
      requireManager(s, ctx.userId);
      const row = detailsRow(s, p.botId);
      if (!row) throw new ProtocolError('NOT_FOUND');
      const nick = p.name === undefined ? null : normalizeNickname(p.name);
      if (nick && s.ctx.db.get('SELECT 1 AS x FROM users WHERE nickname_norm = ? AND id <> ?', nick.norm, p.botId)) throw new ProtocolError('NICK_TAKEN');
      const description = p.description === undefined ? null : cleanMessageContent(p.description);
      if (!s.manage.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      const rename = nick !== null && nick.display !== row.nickname ? nick : null;
      const describe = description !== null && description !== row.description;
      if (rename || describe) {
        s.ctx.db.tx(() => {
          if (rename) {
            s.ctx.db.run('UPDATE users SET nickname = ?, nickname_norm = ? WHERE id = ?', rename.display, rename.norm, p.botId);
            s.ctx.db.run('UPDATE bots SET name = ? WHERE user_id = ?', rename.display, p.botId);
          }
          if (describe) s.ctx.db.run('UPDATE bots SET description = ? WHERE user_id = ?', description, p.botId);
        });
        if (rename) s.textModule.announceMember(p.botId);
        announceBot(s, p.botId);
      }
      return { bot: toDetails(s, detailsRow(s, p.botId)!) };
    },

    'bot.setDescription': (ctx, payload): BotSetDescriptionResult => {
      const p = botSetDescriptionSchema.parse(payload);
      const s = need();
      // A bot, for itself (discord-compat's client.application.edit({ description })).
      if (!isBot(s, ctx.userId)) throw new ProtocolError('FORBIDDEN');
      if (!s.manage.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      const description = cleanMessageContent(p.description);
      const changed = s.ctx.db.run('UPDATE bots SET description = ? WHERE user_id = ? AND description <> ?', description, ctx.userId, description).changes > 0;
      if (changed) announceBot(s, ctx.userId);
      return { description };
    },

    'commands.set': (ctx, payload) => {
      const p = commandsSetSchema.parse(payload);
      const s = need();
      if (!s.ctx.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', ctx.userId)) throw new ProtocolError('FORBIDDEN');
      if (!s.commandsSet.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
      const commands: BotCommand[] = p.commands;
      s.ctx.db.run('UPDATE bots SET commands = ? WHERE user_id = ?', JSON.stringify(commands), ctx.userId);
      s.text.broadcastMembers({ t: 'commands.updated', d: { botId: ctx.userId, commands } satisfies BotCommands });
      return { commands };
    },

    'interaction.invoke': (ctx, payload): InteractionInvokeResult => {
      const p = interactionInvokeSchema.parse(payload);
      const s = need();
      const { channelId, bits } = s.text.textChannel(ctx.userId, p.channelId);
      // People use commands; a bot never acts for someone else (spec §2).
      if (!has(bits, PERMISSIONS.SEND_MESSAGES) || s.text.member(ctx.userId)?.bot !== false) throw new ProtocolError('FORBIDDEN');
      const row = s.ctx.db.get<{ commands: string }>('SELECT commands FROM bots WHERE user_id = ?', p.botId);
      if (!row || !s.text.isMember(p.botId)) throw new ProtocolError('NOT_FOUND');
      const command = readCommands(row.commands).find((c) => c.name === p.command);
      if (!command) throw new ProtocolError('NOT_FOUND');
      if (s.text.channelBits(p.botId, channelId) === 0) throw new ProtocolError('FORBIDDEN');
      const options = checkOptions(command, p.options, ctx.userId, s.text);
      if (!s.invokes.hit(channelId)) throw new ProtocolError('RATE_LIMITED');
      const id = s.interactions.start({ botId: p.botId, channelId, userId: ctx.userId, command: command.name, options });
      // Only a use that reached the bot counts (an offline bot threw BOT_OFFLINE above).
      recordUse(s, { id, botId: p.botId, command: command.name, channelId, userId: ctx.userId });
      return { id };
    },

    'interaction.respond': (ctx, payload): InteractionResult => {
      const p = interactionRespondSchema.parse(payload);
      const s = need();
      const message = s.interactions.respond(ctx.userId, p);
      markAnswered(s, ctx.userId, p.id);
      return { message };
    },

    'interaction.edit': (ctx, payload): InteractionResult => {
      const p = interactionEditSchema.parse(payload);
      return { message: need().interactions.edit(ctx.userId, p) };
    },

    'interaction.followup': (ctx, payload): InteractionResult => {
      const p = interactionFollowupSchema.parse(payload);
      return { message: need().interactions.followup(ctx.userId, p) };
    },
  };

  return {
    name: BOTS_MODULE_NAME,
    features: [FEATURE_BOTS, FEATURE_BOT_SETTINGS],
    handlers,

    init(ctx) {
      const textModule = ctx.getModule<TextModule>(TEXT_MODULE_NAME);
      const text = textModule.bots;
      state = {
        ctx,
        text,
        textModule,
        interactions: new Interactions(ctx, text, {
          firstResponseMs: opts.firstResponseMs ?? BOT_LIMITS.firstResponseMs,
          responseWindowMs: opts.responseWindowMs ?? BOT_LIMITS.responseWindowMs,
          maxLivePerBot: MAX_LIVE_PER_BOT,
        }),
        manage: new SlidingWindowLimiter(BOT_LIMITS.managePerWindow, BOT_LIMITS.manageWindowMs, ctx.now),
        commandsSet: new SlidingWindowLimiter(BOT_LIMITS.commandsSetPerWindow, BOT_LIMITS.commandsSetWindowMs, ctx.now),
        invokes: new SlidingWindowLimiter(BOT_LIMITS.invokesPerChannelPerSecond, 1_000, ctx.now),
        port: 0,
        lastPurge: Number.NEGATIVE_INFINITY,
      };
      const s = state;
      purgeUses(s);
      sweep = setInterval(() => {
        s.manage.sweep();
        s.commandsSet.sweep();
        s.invokes.sweep();
        purgeUses(s);
      }, SWEEP_INTERVAL_MS);
      sweep.unref();
    },

    start({ port }) {
      need().port = port;
    },

    stop() {
      if (sweep) clearInterval(sweep);
      sweep = null;
      state?.interactions.stop();
    },

    welcome: (): BotsWelcome & Record<string, unknown> => {
      const s = need();
      return { botCommands: allCommands(s), botProfiles: allProfiles(s) };
    },

    onSessionOpened(session) {
      touchLastSeen(need(), session.userId);
    },

    onSessionClosed(session, info) {
      // Once per session that ends (a replaced one too); the grace's end changes nothing more.
      if (!info.graceExpired) touchLastSeen(need(), session.userId);
    },
  };
}
