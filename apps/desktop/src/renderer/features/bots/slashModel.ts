// The "/" in the composer (bots spec §3): typing "/" at the start lists the slash commands of the
// bots that see the channel; picking one turns the box into the command and its options as chips
// (text, number, yes/no, person, channel), and Enter sends interaction.invoke. Pure, so the picker,
// the chips and what goes on the wire are tested without a page.
import { BOT_LIMITS, type BotCommand, type CommandChoice, type CommandOption, type CommandOptionType, type InteractionOptionInput, type InteractionOptionValue } from '@ghostlink/shared';
import { fold } from '../chat/mentions.js';

// The commands as bots declare them (shared/bots.ts).
export type SlashOptionType = CommandOptionType;
export type SlashChoice = CommandChoice;
export type SlashOption = CommandOption;
export type SlashCommand = BotCommand;

/** A command as the picker lists it: with the bot that answers it. */
export interface SlashEntry {
  botId: string;
  botName: string;
  botAvatar: string | null;
  command: SlashCommand;
}

/** The longest command name (`^[a-z0-9_-]{1,32}$` on the server). */
export const SLASH_QUERY_MAX = 32;
/** Rows of the picker; more scroll. */
export const SLASH_SUGGESTIONS_MAX = 25;
/** A string option's longest value (the message limit). */
export const SLASH_STRING_MAX = BOT_LIMITS.optionValueMax;

/**
 * The command name being typed: the text starts with "/" and the caret is still in its first word.
 * "/pi|" → "pi"; "/" → ""; "oi /pi", "/ping |" or a caret before the "/" → null.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/') || caret < 1 || caret > text.length) return null;
  const typed = text.slice(1, caret);
  if (typed.length > SLASH_QUERY_MAX || /\s/u.test(typed)) return null;
  // The rest of the first word counts too ("/pi|ng" still looks for "ping").
  const rest = /^\S*/u.exec(text.slice(caret))![0];
  return typed + rest;
}

/** Commands whose name starts with the query first, then those whose name or description contains it. */
export function slashSuggestions(query: string, entries: readonly SlashEntry[], max = SLASH_SUGGESTIONS_MAX): SlashEntry[] {
  const q = fold(query);
  const starts: SlashEntry[] = [];
  const contains: SlashEntry[] = [];
  for (const entry of entries) {
    const name = fold(entry.command.name);
    if (name.startsWith(q)) starts.push(entry);
    else if (q !== '' && (name.includes(q) || fold(entry.command.description).includes(q))) contains.push(entry);
  }
  const order = (a: SlashEntry, b: SlashEntry) => a.command.name.localeCompare(b.command.name) || a.botName.localeCompare(b.botName) || a.botId.localeCompare(b.botId);
  return [...starts.sort(order), ...contains.sort(order)].slice(0, max);
}

// ---- chips ----

/** How a chip is edited: typed text, a typed number, a yes/no or choices list, or the mention picker. */
export type ChipEditor = 'text' | 'number' | 'select' | 'user' | 'channel';

export function chipEditor(option: Pick<SlashOption, 'type' | 'choices'>): ChipEditor {
  if (option.type === 'boolean' || (option.choices?.length ?? 0) > 0) return 'select';
  switch (option.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'user':
      return 'user';
    case 'channel':
      return 'channel';
    default:
      return 'text';
  }
}

export interface Chip {
  option: SlashOption;
  /**
   * What was typed or picked: text for string/integer/number, "true"/"false" for a boolean,
   * the choice's value as text, the user's or channel's id; '' while empty.
   */
  value: string;
  /** A person's or channel's name as the chip shows it ("@Ana", "#geral"). */
  label?: string;
}

/** A command being filled in the composer. */
export interface SlashDraft {
  entry: SlashEntry;
  /** Shown in order: every required option, then the optional ones that were added. */
  chips: readonly Chip[];
}

/** Picking a command: its required options become chips at once. */
export function startDraft(entry: SlashEntry): SlashDraft {
  return { entry, chips: entry.command.options.filter((o) => o.required).map((option) => ({ option, value: '' })) };
}

/** Optional options not added yet, in the command's order. */
export function optionalLeft(draft: SlashDraft): SlashOption[] {
  const shown = new Set(draft.chips.map((c) => c.option.name));
  return draft.entry.command.options.filter((o) => !o.required && !shown.has(o.name));
}

export function addChip(draft: SlashDraft, name: string): SlashDraft {
  const option = optionalLeft(draft).find((o) => o.name === name);
  return option ? { ...draft, chips: [...draft.chips, { option, value: '' }] } : draft;
}

/** Only an optional chip can go. */
export function removeChip(draft: SlashDraft, name: string): SlashDraft {
  const chips = draft.chips.filter((c) => c.option.required || c.option.name !== name);
  return chips.length === draft.chips.length ? draft : { ...draft, chips };
}

export function setChip(draft: SlashDraft, name: string, value: string, label?: string): SlashDraft {
  return {
    ...draft,
    chips: draft.chips.map((c) => (c.option.name === name ? { option: c.option, value, ...(label !== undefined ? { label } : {}) } : c)),
  };
}

/** The choices a select chip offers: a boolean's yes/no, or the bot's choices. */
export function chipChoices(option: Pick<SlashOption, 'type' | 'choices'>, labels: { yes: string; no: string }): SlashChoice[] {
  if (option.type === 'boolean') return [{ name: labels.yes, value: 'true' }, { name: labels.no, value: 'false' }];
  return [...(option.choices ?? [])];
}

export type ChipError = 'required' | 'integer' | 'number' | 'choice' | 'tooLong';

const USER_ID = /^[0-9a-f]{32}$/;
const CHANNEL_ID = /^[A-Z2-7]{26}$/;

/** What is wrong with a chip, or null. An empty optional chip is fine (it is left out). */
export function chipError(chip: Chip): ChipError | null {
  const { option } = chip;
  const value = chip.value.trim();
  if (value === '') return option.required ? 'required' : null;
  const choices = option.choices ?? [];
  if (option.type !== 'boolean' && choices.length > 0) return choices.some((c) => String(c.value) === value) ? null : 'choice';
  switch (option.type) {
    case 'string':
      return value.length > SLASH_STRING_MAX ? 'tooLong' : null;
    case 'integer':
      return /^-?\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? null : 'integer';
    case 'number':
      return /^-?(\d+([.,]\d*)?|[.,]\d+)$/.test(value) && Number.isFinite(Number(value.replace(',', '.'))) ? null : 'number';
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'choice';
    case 'user':
      return USER_ID.test(value) ? null : 'required';
    case 'channel':
      return CHANNEL_ID.test(value) ? null : 'required';
  }
}

/** The first chip with a problem, for the error line and the focus. */
export function firstError(draft: SlashDraft): { name: string; error: ChipError } | null {
  for (const chip of draft.chips) {
    const error = chipError(chip);
    if (error) return { name: chip.option.name, error };
  }
  return null;
}

/** A chip's value as the bot receives it: numbers as numbers, yes/no as a boolean, ids as text. */
export function chipValue(chip: Chip): InteractionOptionValue {
  const { option } = chip;
  const value = chip.value.trim();
  switch (option.type) {
    case 'integer':
      return Number(value);
    case 'number':
      return Number(value.replace(',', '.'));
    case 'boolean':
      return value === 'true';
    default: {
      // An option with choices sends the choice's own value (a bot may use numbers there).
      const choice = option.choices?.find((c) => String(c.value) === value);
      return choice ? choice.value : value;
    }
  }
}

/** The options of interaction.invoke: every filled chip, in order; empty optional ones are left out. Null while a chip is wrong. */
export function invokeOptions(draft: SlashDraft): InteractionOptionInput[] | null {
  if (firstError(draft)) return null;
  return draft.chips.filter((chip) => chip.value.trim() !== '').map((chip) => ({ name: chip.option.name, value: chipValue(chip) }));
}
