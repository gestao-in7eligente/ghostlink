/**
 * The discord.js v14 / discord-api-types constants a bot imports, with the same names and values.
 * Accepting a value here does not mean GhostLink acts on it: intents and partials are ignored
 * (a bot sees every channel its roles let it see), and Client.on() refuses the events outside
 * the subset.
 */

/** discord.js `Events`. Only ClientReady, MessageCreate, InteractionCreate, Error, Warn and Debug fire on GhostLink. */
export enum Events {
  ApplicationCommandPermissionsUpdate = 'applicationCommandPermissionsUpdate',
  AutoModerationActionExecution = 'autoModerationActionExecution',
  AutoModerationRuleCreate = 'autoModerationRuleCreate',
  AutoModerationRuleDelete = 'autoModerationRuleDelete',
  AutoModerationRuleUpdate = 'autoModerationRuleUpdate',
  CacheSweep = 'cacheSweep',
  ChannelCreate = 'channelCreate',
  ChannelDelete = 'channelDelete',
  ChannelPinsUpdate = 'channelPinsUpdate',
  ChannelUpdate = 'channelUpdate',
  ClientReady = 'clientReady',
  Debug = 'debug',
  EntitlementCreate = 'entitlementCreate',
  EntitlementDelete = 'entitlementDelete',
  EntitlementUpdate = 'entitlementUpdate',
  Error = 'error',
  GuildAuditLogEntryCreate = 'guildAuditLogEntryCreate',
  GuildAvailable = 'guildAvailable',
  GuildBanAdd = 'guildBanAdd',
  GuildBanRemove = 'guildBanRemove',
  GuildCreate = 'guildCreate',
  GuildDelete = 'guildDelete',
  GuildEmojiCreate = 'emojiCreate',
  GuildEmojiDelete = 'emojiDelete',
  GuildEmojiUpdate = 'emojiUpdate',
  GuildIntegrationsUpdate = 'guildIntegrationsUpdate',
  GuildMemberAdd = 'guildMemberAdd',
  GuildMemberAvailable = 'guildMemberAvailable',
  GuildMemberRemove = 'guildMemberRemove',
  GuildMembersChunk = 'guildMembersChunk',
  GuildMemberUpdate = 'guildMemberUpdate',
  GuildRoleCreate = 'roleCreate',
  GuildRoleDelete = 'roleDelete',
  GuildRoleUpdate = 'roleUpdate',
  GuildScheduledEventCreate = 'guildScheduledEventCreate',
  GuildScheduledEventDelete = 'guildScheduledEventDelete',
  GuildScheduledEventUpdate = 'guildScheduledEventUpdate',
  GuildScheduledEventUserAdd = 'guildScheduledEventUserAdd',
  GuildScheduledEventUserRemove = 'guildScheduledEventUserRemove',
  GuildStickerCreate = 'stickerCreate',
  GuildStickerDelete = 'stickerDelete',
  GuildStickerUpdate = 'stickerUpdate',
  GuildUnavailable = 'guildUnavailable',
  GuildUpdate = 'guildUpdate',
  InteractionCreate = 'interactionCreate',
  Invalidated = 'invalidated',
  InviteCreate = 'inviteCreate',
  InviteDelete = 'inviteDelete',
  MessageBulkDelete = 'messageDeleteBulk',
  MessageCreate = 'messageCreate',
  MessageDelete = 'messageDelete',
  MessagePollVoteAdd = 'messagePollVoteAdd',
  MessagePollVoteRemove = 'messagePollVoteRemove',
  MessageReactionAdd = 'messageReactionAdd',
  MessageReactionRemove = 'messageReactionRemove',
  MessageReactionRemoveAll = 'messageReactionRemoveAll',
  MessageReactionRemoveEmoji = 'messageReactionRemoveEmoji',
  MessageUpdate = 'messageUpdate',
  PresenceUpdate = 'presenceUpdate',
  Raw = 'raw',
  ShardDisconnect = 'shardDisconnect',
  ShardError = 'shardError',
  ShardReady = 'shardReady',
  ShardReconnecting = 'shardReconnecting',
  ShardResume = 'shardResume',
  StageInstanceCreate = 'stageInstanceCreate',
  StageInstanceDelete = 'stageInstanceDelete',
  StageInstanceUpdate = 'stageInstanceUpdate',
  ThreadCreate = 'threadCreate',
  ThreadDelete = 'threadDelete',
  ThreadListSync = 'threadListSync',
  ThreadMembersUpdate = 'threadMembersUpdate',
  ThreadMemberUpdate = 'threadMemberUpdate',
  ThreadUpdate = 'threadUpdate',
  TypingStart = 'typingStart',
  UserUpdate = 'userUpdate',
  VoiceServerUpdate = 'voiceServerUpdate',
  VoiceStateUpdate = 'voiceStateUpdate',
  Warn = 'warn',
  WebhooksUpdate = 'webhookUpdate',
}

/** Accepted by `new Client({ intents })` and ignored. */
export enum GatewayIntentBits {
  Guilds = 1,
  GuildMembers = 2,
  GuildModeration = 4,
  // discord-api-types keeps the old names as aliases of the same bits.
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  GuildBans = 4,
  GuildEmojisAndStickers = 8,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  GuildExpressions = 8,
  GuildIntegrations = 16,
  GuildWebhooks = 32,
  GuildInvites = 64,
  GuildVoiceStates = 128,
  GuildPresences = 256,
  GuildMessages = 512,
  GuildMessageReactions = 1024,
  GuildMessageTyping = 2048,
  DirectMessages = 4096,
  DirectMessageReactions = 8192,
  DirectMessageTyping = 16384,
  MessageContent = 32768,
  GuildScheduledEvents = 65536,
  AutoModerationConfiguration = 1048576,
  AutoModerationExecution = 2097152,
  GuildMessagePolls = 16777216,
  DirectMessagePolls = 33554432,
}

/** Accepted by `new Client({ partials })` and ignored. */
export enum Partials {
  User = 0,
  Channel = 1,
  GuildMember = 2,
  Message = 3,
  Reaction = 4,
  GuildScheduledEvent = 5,
  ThreadMember = 6,
}

export enum ChannelType {
  GuildText = 0,
  DM = 1,
  GuildVoice = 2,
  GroupDM = 3,
  GuildCategory = 4,
  GuildAnnouncement = 5,
  AnnouncementThread = 10,
  PublicThread = 11,
  PrivateThread = 12,
  GuildStageVoice = 13,
  GuildDirectory = 14,
  GuildForum = 15,
  GuildMedia = 16,
}

export enum ApplicationCommandType {
  ChatInput = 1,
  User = 2,
  Message = 3,
  PrimaryEntryPoint = 4,
}

export enum ApplicationCommandOptionType {
  Subcommand = 1,
  SubcommandGroup = 2,
  String = 3,
  Integer = 4,
  Boolean = 5,
  User = 6,
  Channel = 7,
  Role = 8,
  Mentionable = 9,
  Number = 10,
  Attachment = 11,
}

export enum InteractionType {
  Ping = 1,
  ApplicationCommand = 2,
  MessageComponent = 3,
  ApplicationCommandAutocomplete = 4,
  ModalSubmit = 5,
}

/** Only Ephemeral (and the no-op SuppressEmbeds) mean something on GhostLink. */
export enum MessageFlags {
  Crossposted = 1,
  IsCrosspost = 2,
  SuppressEmbeds = 4,
  SourceMessageDeleted = 8,
  Urgent = 16,
  HasThread = 32,
  Ephemeral = 64,
  Loading = 128,
  FailedToMentionSomeRolesInThread = 256,
  SuppressNotifications = 4096,
  IsVoiceMessage = 8192,
  HasSnapshot = 16384,
  IsComponentsV2 = 32768,
}

export enum MessageType {
  Default = 0,
  Reply = 19,
  ChatInputCommand = 20,
}

/** discord.js IntentsBitField, enough for `new Client({ intents: new IntentsBitField([...]) })`. */
export class IntentsBitField {
  static Flags = GatewayIntentBits;
  bitfield: number;

  constructor(bits: number | readonly (number | keyof typeof GatewayIntentBits)[] = 0) {
    this.bitfield = IntentsBitField.resolve(bits);
  }

  static resolve(bits: number | readonly (number | keyof typeof GatewayIntentBits)[]): number {
    if (typeof bits === 'number') return bits;
    return bits.reduce<number>((acc, b) => acc | (typeof b === 'number' ? b : (GatewayIntentBits[b] ?? 0)), 0);
  }

  has(bit: number | keyof typeof GatewayIntentBits): boolean {
    const n = IntentsBitField.resolve([bit]);
    return (this.bitfield & n) === n;
  }

  add(...bits: (number | keyof typeof GatewayIntentBits)[]): this {
    this.bitfield |= IntentsBitField.resolve(bits);
    return this;
  }
}
