/**
 * SlashCommandBuilder and its option builders (@discordjs/builders), for what GhostLink commands
 * have: a name, a description, and string / integer / number / boolean / user / channel options,
 * required or not, with choices. Names follow GhostLink's rule (bots spec §2), stricter than
 * Discord's: 1 to 32 of a-z, 0-9, _ and -.
 */
import { BOT_LIMITS, COMMAND_NAME } from '@ghostlink/shared';
import type { APIApplicationCommandOption, APIApplicationCommandOptionChoice, RESTPostAPIChatInputApplicationCommandsJSONBody } from './commands.js';
import { ApplicationCommandOptionType, ApplicationCommandType } from './enums.js';
import { GhostLinkUnsupported, unsupportedMembers } from './errors.js';

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !COMMAND_NAME.test(name)) {
    throw new RangeError(`Invalid name ${JSON.stringify(name)}: GhostLink takes 1 to 32 characters of a-z, 0-9, _ and -`);
  }
  return name;
}

function validateDescription(description: unknown): string {
  if (typeof description !== 'string' || description.length < 1 || description.length > BOT_LIMITS.descriptionMax) {
    throw new RangeError(`Invalid description ${JSON.stringify(description)}: 1 to ${BOT_LIMITS.descriptionMax} characters`);
  }
  return description;
}

abstract class OptionBuilder {
  readonly name: string = undefined as unknown as string;
  readonly description: string = undefined as unknown as string;
  readonly required: boolean = false;
  abstract readonly type: ApplicationCommandOptionType;

  setName(name: string): this {
    Reflect.set(this, 'name', validateName(name));
    return this;
  }

  setDescription(description: string): this {
    Reflect.set(this, 'description', validateDescription(description));
    return this;
  }

  setRequired(required = true): this {
    if (typeof required !== 'boolean') throw new TypeError('setRequired takes a boolean');
    Reflect.set(this, 'required', required);
    return this;
  }

  toJSON(): APIApplicationCommandOption {
    validateName(this.name);
    validateDescription(this.description);
    return { type: this.type, name: this.name, description: this.description, required: this.required };
  }
}

abstract class ChoicesOptionBuilder<T extends string | number> extends OptionBuilder {
  readonly choices?: APIApplicationCommandOptionChoice[];

  protected abstract checkChoice(value: unknown): value is T;

  addChoices(...choices: readonly { name: string; value: T }[]): this {
    const list = choices.flat() as { name: string; value: T }[];
    const all = [...(this.choices ?? []), ...list];
    if (all.length > BOT_LIMITS.maxChoices) throw new RangeError(`At most ${BOT_LIMITS.maxChoices} choices`);
    for (const c of list) {
      if (typeof c?.name !== 'string' || c.name.length < 1 || c.name.length > BOT_LIMITS.choiceNameMax) throw new RangeError(`Invalid choice name ${JSON.stringify(c?.name)}`);
      if (!this.checkChoice(c.value)) throw new TypeError(`Invalid choice value ${JSON.stringify(c.value)} for a ${ApplicationCommandOptionType[this.type]} option`);
    }
    Reflect.set(this, 'choices', all.map((c) => ({ name: c.name, value: c.value })));
    return this;
  }

  setChoices(...choices: readonly { name: string; value: T }[]): this {
    Reflect.set(this, 'choices', undefined);
    return choices.flat().length === 0 ? this : this.addChoices(...choices);
  }

  /** Only `false`: GhostLink has no autocomplete. */
  setAutocomplete(autocomplete: boolean): this {
    if (autocomplete) throw new GhostLinkUnsupported(`${this.constructor.name}.setAutocomplete(true)`);
    return this;
  }

  override toJSON(): APIApplicationCommandOption {
    return { ...super.toJSON(), ...(this.choices && this.choices.length > 0 ? { choices: this.choices.map((c) => ({ ...c })) } : {}) };
  }
}

export class SlashCommandStringOption extends ChoicesOptionBuilder<string> {
  readonly type = ApplicationCommandOptionType.String;

  protected checkChoice(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= BOT_LIMITS.choiceNameMax;
  }
}

export class SlashCommandIntegerOption extends ChoicesOptionBuilder<number> {
  readonly type = ApplicationCommandOptionType.Integer;

  protected checkChoice(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
  }
}

export class SlashCommandNumberOption extends ChoicesOptionBuilder<number> {
  readonly type = ApplicationCommandOptionType.Number;

  protected checkChoice(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }
}

export class SlashCommandBooleanOption extends OptionBuilder {
  readonly type = ApplicationCommandOptionType.Boolean;
}

export class SlashCommandUserOption extends OptionBuilder {
  readonly type = ApplicationCommandOptionType.User;
}

/** Any channel of the server (text or voice); GhostLink cannot narrow it by type. */
export class SlashCommandChannelOption extends OptionBuilder {
  readonly type = ApplicationCommandOptionType.Channel;
}

const OPTION_UNSUPPORTED = ['setNameLocalizations', 'setNameLocalization', 'setDescriptionLocalizations', 'setDescriptionLocalization'];
for (const [cls, extra] of [
  [SlashCommandStringOption, ['setMinLength', 'setMaxLength']],
  [SlashCommandIntegerOption, ['setMinValue', 'setMaxValue']],
  [SlashCommandNumberOption, ['setMinValue', 'setMaxValue']],
  [SlashCommandBooleanOption, []],
  [SlashCommandUserOption, []],
  [SlashCommandChannelOption, ['addChannelTypes']],
] as const) {
  unsupportedMembers(cls.prototype, cls.name, [...OPTION_UNSUPPORTED, ...extra]);
}

type OptionInput<T> = T | ((builder: T) => T);

/** A slash command (`/name`), as in discord.js. */
export class SlashCommandBuilder {
  readonly name: string = undefined as unknown as string;
  readonly description: string = undefined as unknown as string;
  readonly options: OptionBuilder[] = [];
  readonly dm_permission: boolean | undefined = undefined;
  readonly nsfw: boolean | undefined = undefined;

  setName(name: string): this {
    Reflect.set(this, 'name', validateName(name));
    return this;
  }

  setDescription(description: string): this {
    Reflect.set(this, 'description', validateDescription(description));
    return this;
  }

  /** Only `false`: bots have no direct messages on GhostLink. */
  setDMPermission(enabled: boolean | null | undefined): this {
    if (enabled === true) throw new GhostLinkUnsupported('SlashCommandBuilder.setDMPermission(true)', 'bots have no direct messages on GhostLink');
    Reflect.set(this, 'dm_permission', enabled ?? undefined);
    return this;
  }

  /** Only `false`. */
  setNSFW(nsfw = true): this {
    if (nsfw) throw new GhostLinkUnsupported('SlashCommandBuilder.setNSFW(true)');
    Reflect.set(this, 'nsfw', false);
    return this;
  }

  addStringOption(input: OptionInput<SlashCommandStringOption>): this {
    return this.#add(input, SlashCommandStringOption);
  }

  addIntegerOption(input: OptionInput<SlashCommandIntegerOption>): this {
    return this.#add(input, SlashCommandIntegerOption);
  }

  addNumberOption(input: OptionInput<SlashCommandNumberOption>): this {
    return this.#add(input, SlashCommandNumberOption);
  }

  addBooleanOption(input: OptionInput<SlashCommandBooleanOption>): this {
    return this.#add(input, SlashCommandBooleanOption);
  }

  addUserOption(input: OptionInput<SlashCommandUserOption>): this {
    return this.#add(input, SlashCommandUserOption);
  }

  addChannelOption(input: OptionInput<SlashCommandChannelOption>): this {
    return this.#add(input, SlashCommandChannelOption);
  }

  #add<T extends OptionBuilder>(input: OptionInput<T>, Kind: new () => T): this {
    if (this.options.length >= BOT_LIMITS.maxOptions) throw new RangeError(`At most ${BOT_LIMITS.maxOptions} options`);
    const option = typeof input === 'function' ? input(new Kind()) : input;
    if (!(option instanceof Kind)) throw new TypeError(`Expected a ${Kind.name}`);
    this.options.push(option);
    return this;
  }

  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody {
    validateName(this.name);
    validateDescription(this.description);
    const options = this.options.map((o) => o.toJSON());
    let optionalSeen = false;
    for (const o of options) {
      if (o.required && optionalSeen) throw new RangeError(`/${this.name}: required options must be placed before non-required options`);
      if (!o.required) optionalSeen = true;
    }
    if (new Set(options.map((o) => o.name)).size !== options.length) throw new RangeError(`/${this.name}: option names must be unique`);
    return {
      name: this.name,
      description: this.description,
      options,
      type: ApplicationCommandType.ChatInput,
      ...(this.dm_permission === undefined ? {} : { dm_permission: this.dm_permission }),
      ...(this.nsfw === undefined ? {} : { nsfw: this.nsfw }),
    };
  }
}
unsupportedMembers(SlashCommandBuilder.prototype, 'SlashCommandBuilder', [
  'addSubcommand', 'addSubcommandGroup', 'addRoleOption', 'addMentionableOption', 'addAttachmentOption',
  'setDefaultMemberPermissions', 'setDefaultPermission', 'setContexts', 'setIntegrationTypes',
  'setNameLocalizations', 'setNameLocalization', 'setDescriptionLocalizations', 'setDescriptionLocalization',
]);
