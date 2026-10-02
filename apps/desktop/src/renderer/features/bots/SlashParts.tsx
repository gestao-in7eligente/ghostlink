import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Hash, Plus, Volume2, X } from 'lucide-react';
import type { Channel, Member } from '@ghostlink/shared';
import type { Translate } from '../../i18n/index.js';
import { Avatar, Select } from '../../layout/primitives.js';
import { fold, mentionSuggestions } from '../chat/mentions.js';
import { BotTag } from './BotParts.js';
import b from './bots.module.css';
import {
  addChip,
  chipChoices,
  chipEditor,
  chipError,
  optionalLeft,
  removeChip,
  setChip,
  type Chip,
  type ChipError,
  type SlashDraft,
  type SlashEntry,
} from './slashModel.js';

/** The "/" list over the composer (bots spec §3): name, description and the bot's photo and name. */
export function SlashPicker({
  listId,
  entries,
  active,
  t,
  onPick,
  onHover,
}: {
  listId: string;
  entries: readonly SlashEntry[];
  active: number;
  t: Translate;
  onPick: (entry: SlashEntry) => void;
  onHover: (index: number) => void;
}) {
  useLayoutEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, active]);
  return (
    <div className={b.picker} data-slash-picker>
      <p className={b.pickerTitle} aria-hidden="true">
        {t('slash.suggestions')}
      </p>
      <ul id={listId} className={b.pickerList} role="listbox" aria-label={t('slash.suggestions')}>
        {entries.map((entry, i) => {
          const { command } = entry;
          const args = command.options.filter((o) => o.required).map((o) => o.name);
          return (
            <li
              key={`${entry.botId}/${command.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-label={`/${command.name}, ${command.description}, ${t('slash.by', { bot: entry.botName })}`}
              className={i === active ? `${b.option} ${b.optionActive}` : b.option}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(entry);
              }}
              onMouseEnter={() => onHover(i)}
            >
              <Avatar size={32} name={entry.botName} hash={entry.botAvatar} />
              <span className={b.optionText}>
                <span className={b.optionName}>
                  /{command.name}
                  {args.length > 0 && <span className={b.optionArgs}> {args.join(' ')}</span>}
                </span>
                {command.description && <span className={b.optionDescription}>{command.description}</span>}
              </span>
              <span className={b.optionBot}>{entry.botName}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A person or a channel a chip can point at. */
interface Target {
  id: string;
  label: string;
  bot: boolean;
  avatar: string | null;
  channel: Channel | null;
}

const TARGETS_MAX = 8;

/** Focuses a chip's editor (an input, or the Select's button inside its wrapper); undefined when there is none. */
function focusable(el: HTMLElement | undefined): true | undefined {
  const target = el && (el.matches('input, button') ? el : el.querySelector<HTMLElement>('button'));
  if (!target) return undefined;
  target.focus();
  return true;
}

function userTargets(query: string, members: readonly Member[]): Target[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  return mentionSuggestions(query.replace(/^@/, ''), { members, roles: [], canMentionEveryone: false, everyoneLabel: '' })
    .filter((c) => c.kind === 'user')
    .map((c) => {
      const m = byId.get(c.id)!;
      return { id: c.id, label: c.display, bot: m.bot, avatar: m.avatar, channel: null };
    });
}

function channelTargets(query: string, channels: readonly Channel[]): Target[] {
  const q = fold(query.replace(/^#/, ''));
  const starts: Target[] = [];
  const contains: Target[] = [];
  for (const channel of channels) {
    const key = fold(channel.name);
    const target = { id: channel.id, label: `#${channel.name}`, bot: false, avatar: null, channel };
    if (key.startsWith(q)) starts.push(target);
    else if (q !== '' && key.includes(q)) contains.push(target);
  }
  return [...starts, ...contains].slice(0, TARGETS_MAX);
}

const ERROR_KEYS: Readonly<Record<ChipError, 'slash.error.required' | 'slash.error.integer' | 'slash.error.number' | 'slash.error.choice' | 'slash.error.tooLong'>> = {
  required: 'slash.error.required',
  integer: 'slash.error.integer',
  number: 'slash.error.number',
  choice: 'slash.error.choice',
  tooLong: 'slash.error.tooLong',
};

export function chipErrorText(t: Translate, name: string, error: ChipError): string {
  return t(ERROR_KEYS[error], { name });
}

/**
 * The picked command in place of the text box (bots spec §3): the command, then a chip per option,
 * edited by type (text, number, yes/no or choices with the app's Select, a person or a channel
 * with the mention list), and "+ option" for the optional ones. Enter sends, Esc cancels, Tab moves
 * between chips.
 */
export function SlashDraftBox({
  draft,
  members,
  channels,
  t,
  busy,
  invalid,
  focusChip,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: SlashDraft;
  members: readonly Member[];
  /** Every channel the person sees, for a channel option. */
  channels: readonly Channel[];
  t: Translate;
  busy: boolean;
  /** The chip shown as wrong after a failed Enter. */
  invalid: string | null;
  /** Bumped to move the focus to a chip (its name), e.g. the wrong one. */
  focusChip: { name: string | null; seq: number };
  onChange: (draft: SlashDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const listId = useId();
  const commandRef = useRef<HTMLButtonElement>(null);
  const inputs = useRef(new Map<string, HTMLElement>());
  /** The person/channel chip being typed in, with what was typed. */
  const [lookup, setLookup] = useState<{ name: string; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const { entry } = draft;

  // Focus: the requested chip, or the first one, or the command itself.
  useEffect(() => {
    const target = focusChip.name !== null ? inputs.current.get(focusChip.name) : inputs.current.get(draft.chips[0]?.option.name ?? '');
    if (!focusable(target)) commandRef.current?.focus();
    // Only when a focus is asked for (a new command, a wrong chip, an added option).
  }, [focusChip.seq]);

  const lookupChip = lookup ? draft.chips.find((c) => c.option.name === lookup.name) : undefined;
  const targets = useMemo(() => {
    if (!lookup || !lookupChip) return [];
    return chipEditor(lookupChip.option) === 'user' ? userTargets(lookup.text, members) : channelTargets(lookup.text, channels);
  }, [lookup, lookupChip, members, channels]);
  const open = targets.length > 0;
  const current = Math.min(active, Math.max(0, targets.length - 1));

  const pickTarget = (chip: Chip, target: Target) => {
    onChange(setChip(draft, chip.option.name, target.id, target.label));
    setLookup(null);
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, chip: Chip | null) => {
    if (e.nativeEvent.isComposing) return;
    if (open && chip && lookup?.name === chip.option.name) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickTarget(chip, targets[current]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setLookup(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    // Backspace on the command (or an empty first chip) takes the command away.
    if (e.key === 'Backspace' && (chip === null || (chip === draft.chips[0] && chip.value === '' && (e.target as HTMLInputElement).value === ''))) {
      e.preventDefault();
      onCancel();
    }
  };

  const register = (name: string) => (el: HTMLElement | null) => {
    if (el) inputs.current.set(name, el);
    else inputs.current.delete(name);
  };

  const chipEditorFor = (chip: Chip): ReactNode => {
    const { option } = chip;
    const label = t('slash.optionLabel', { name: option.name, description: option.description });
    const kind = chipEditor(option);
    if (kind === 'select') {
      const choices = chipChoices(option, { yes: t('slash.yes'), no: t('slash.no') });
      return (
        // The Select handles its own Enter, arrows and Esc while open (and prevents them); the rest is the draft's.
        <span ref={register(option.name)} onKeyDown={(e) => !e.defaultPrevented && onKeyDown(e, chip)} className={b.chipSelectWrap}>
          <Select
            value={chip.value}
            label={label}
            className={b.chipSelect}
            disabled={busy}
            options={[{ value: '', label: t('slash.choose') }, ...choices.map((c) => ({ value: String(c.value), label: c.name }))]}
            onChange={(value) => onChange(setChip(draft, option.name, value))}
          />
        </span>
      );
    }
    if (kind === 'user' || kind === 'channel') {
      const typing = lookup?.name === option.name;
      const shown = typing ? lookup.text : (chip.label ?? '');
      return (
        <input
          ref={register(option.name)}
          className={b.chipInput}
          value={shown}
          size={Math.max(10, Math.min(40, shown.length + 1))}
          placeholder={t(kind === 'user' ? 'slash.pickUser' : 'slash.pickChannel')}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={typing && open}
          aria-controls={typing && open ? listId : undefined}
          aria-activedescendant={typing && open ? `${listId}-${current}` : undefined}
          role="combobox"
          disabled={busy}
          spellCheck={false}
          onFocus={() => setLookup({ name: option.name, text: chip.label ?? '' })}
          onBlur={() => setLookup((l) => (l?.name === option.name ? null : l))}
          onChange={(e) => {
            setLookup({ name: option.name, text: e.target.value });
            setActive(0);
            // Typing again forgets the person (or channel) picked before.
            if (chip.value !== '') onChange(setChip(draft, option.name, '', ''));
          }}
          onKeyDown={(e) => onKeyDown(e, chip)}
        />
      );
    }
    return (
      <input
        ref={register(option.name)}
        className={b.chipInput}
        value={chip.value}
        size={Math.max(8, Math.min(48, chip.value.length + 1))}
        inputMode={kind === 'number' ? (option.type === 'integer' ? 'numeric' : 'decimal') : undefined}
        placeholder={option.description}
        aria-label={label}
        aria-invalid={invalid === option.name || undefined}
        disabled={busy}
        spellCheck={kind === 'text'}
        onChange={(e) => onChange(setChip(draft, option.name, e.target.value))}
        onKeyDown={(e) => onKeyDown(e, chip)}
      />
    );
  };

  const left = optionalLeft(draft);
  return (
    <div className={b.draft} role="group" aria-label={t('slash.command', { command: entry.command.name, bot: entry.botName })} data-slash-draft>
      <button ref={commandRef} type="button" className={b.command} aria-label={t('slash.command', { command: entry.command.name, bot: entry.botName })} onKeyDown={(e) => onKeyDown(e, null)}>
        <Avatar size={18} name={entry.botName} hash={entry.botAvatar} />/{entry.command.name}
      </button>
      {draft.chips.map((chip) => {
        const wrong = invalid === chip.option.name && chipError(chip) !== null;
        const classes = [b.chip, chip.option.required ? '' : b.chipOptional, wrong ? b.chipInvalid : ''].filter(Boolean).join(' ');
        return (
          <span key={chip.option.name} className={classes} data-chip={chip.option.name}>
            <span className={b.chipName} title={chip.option.description}>
              {chip.option.name}
            </span>
            {chipEditorFor(chip)}
            {!chip.option.required && (
              <button
                type="button"
                className={b.chipRemove}
                aria-label={t('slash.removeOption', { name: chip.option.name })}
                title={t('slash.removeOption', { name: chip.option.name })}
                onClick={() => {
                  onChange(removeChip(draft, chip.option.name));
                  commandRef.current?.focus();
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
      {left.map((option) => (
        <button
          key={option.name}
          type="button"
          className={b.addOption}
          aria-label={t('slash.addOption', { name: option.name })}
          title={option.description}
          onClick={() => {
            onChange(addChip(draft, option.name));
            requestAnimationFrame(() => focusable(inputs.current.get(option.name)));
          }}
        >
          <Plus size={12} aria-hidden="true" />
          {option.name}
        </button>
      ))}
      {open && lookupChip && (
        <div className={b.picker}>
          <ul id={listId} className={`${b.pickerList} ${b.pickerListTop}`} role="listbox" aria-label={t(chipEditor(lookupChip.option) === 'user' ? 'slash.pickUser' : 'slash.pickChannel')}>
            {targets.map((target, i) => (
              <li
                key={target.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={i === current ? `${b.option} ${b.optionActive}` : b.option}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickTarget(lookupChip, target);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={b.pickerEntry}>
                  {target.channel ? (
                    target.channel.type === 'voice' ? (
                      <Volume2 size={18} aria-hidden="true" />
                    ) : (
                      <Hash size={18} aria-hidden="true" />
                    )
                  ) : (
                    <Avatar size={24} name={target.label.replace(/^@/, '')} hash={target.avatar} />
                  )}
                  <span className={b.optionName}>{target.channel ? target.channel.name : target.label}</span>
                  {target.bot && <BotTag t={t} />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
