import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Channel } from '@ghostlink/shared';
import { errorCodeOf, errorMessage, type Translate } from '../../i18n/index.js';
import { useTextStore } from '../../stores/text.js';
import { invokeCommand } from './botActions.js';
import { channelCommands } from './botsModel.js';
import b from './bots.module.css';
import { SlashDraftBox, SlashPicker, chipErrorText } from './SlashParts.js';
import { chipError, firstError, invokeOptions, slashQuery, slashSuggestions, startDraft, type ChipError, type SlashDraft, type SlashEntry } from './slashModel.js';

export interface SlashCommands {
  /** The command being filled, which takes the text box's place; null while typing a message. */
  draft: SlashDraft | null;
  /** The "/" list is open (the text box's combobox points at it). */
  open: boolean;
  listId: string;
  active: number;
  busy: boolean;
  /** The text box's keys while the list is open; true when one was used. */
  onTextKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  submit(): void;
  /** Over the composer: the "/" list. */
  picker: ReactNode;
  /** In the composer box, in place of the text: the command and its chips. */
  box: ReactNode;
  /** Under the composer: what is wrong, or the keys. */
  footer: ReactNode;
}

type SlashError = { kind: 'chip'; name: string; error: ChipError } | { kind: 'request'; code: string };

/**
 * The composer's "/" (bots spec §3): typing "/" at the start lists the commands of the bots that see
 * the channel; picking one (Enter, Tab or a click) swaps the text for the command and its option
 * chips; Enter sends interaction.invoke and the answer arrives in the chat; Esc (or Backspace on the
 * command) brings back "/name" as text.
 */
export function useSlashCommands({
  channel,
  canSend,
  editing,
  text,
  caret,
  t,
  setText,
  onSent,
}: {
  channel: Channel;
  canSend: boolean;
  /** Editing a message: no commands. */
  editing: boolean;
  text: string;
  caret: number;
  t: Translate;
  /** Replaces the text and puts the focus at its end (the text box is back on screen then). */
  setText: (text: string) => void;
  onSent: () => void;
}): SlashCommands {
  const listId = useId();
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const commands = useTextStore((s) => s.bots.commands);
  const channelsById = useTextStore((s) => s.channels.byId);
  const entries = useMemo(() => channelCommands({ server, members }, commands, channel), [server, members, commands, channel]);
  const memberList = useMemo(() => Object.values(members.byId), [members]);
  const channelList = useMemo(() => Object.values(channelsById).sort((a, b2) => (a.type === b2.type ? a.position - b2.position : a.type === 'text' ? -1 : 1)), [channelsById]);
  const [draft, setDraft] = useState<SlashDraft | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SlashError | null>(null);
  const [focus, setFocus] = useState<{ name: string | null; seq: number }>({ name: null, seq: 0 });

  // The command went away meanwhile (its bot left or stopped seeing the channel, or changed its commands).
  const still = draft !== null && entries.some((e) => e.botId === draft.entry.botId && e.command.name === draft.entry.command.name);
  useEffect(() => {
    if (draft !== null && !still && !busy) setDraft(null);
  }, [draft, still, busy]);

  const query = canSend && !editing && draft === null && entries.length > 0 ? slashQuery(text, caret) : null;
  const list = useMemo(() => (query === null || dismissed === text ? [] : slashSuggestions(query, entries)), [query, dismissed, text, entries]);
  const open = list.length > 0;
  const active = Math.min(selected, Math.max(0, list.length - 1));

  const pick = (entry: SlashEntry) => {
    setDraft(startDraft(entry));
    setError(null);
    setSelected(0);
    setFocus((f) => ({ name: null, seq: f.seq + 1 }));
  };

  const cancel = () => {
    if (!draft || busy) return;
    const name = draft.entry.command.name;
    setDraft(null);
    setError(null);
    setText(`/${name}`);
  };

  const submit = () => {
    if (!draft || busy) return;
    const wrong = firstError(draft);
    if (wrong) {
      setError({ kind: 'chip', ...wrong });
      setFocus((f) => ({ name: wrong.name, seq: f.seq + 1 }));
      return;
    }
    const options = invokeOptions(draft)!;
    setBusy(true);
    setError(null);
    invokeCommand(channel.id, draft.entry.botId, draft.entry.command.name, options)
      .then(() => {
        setDraft(null);
        setText('');
        onSent();
      })
      .catch((e: unknown) => setError({ kind: 'request', code: errorCodeOf(e) }))
      .finally(() => setBusy(false));
  };

  const onTextKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        setSelected((active + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
        return true;
      case 'Enter':
      case 'Tab':
        if (e.shiftKey) return false;
        e.preventDefault();
        pick(list[active]!);
        return true;
      case 'Escape':
        e.preventDefault();
        setDismissed(text);
        return true;
      default:
        return false;
    }
  };

  const picker = open ? <SlashPicker listId={listId} entries={list} active={active} t={t} onPick={pick} onHover={setSelected} /> : null;
  const box = draft ? (
    <SlashDraftBox
      draft={draft}
      members={memberList}
      channels={channelList}
      t={t}
      busy={busy}
      invalid={error?.kind === 'chip' ? error.name : null}
      focusChip={focus}
      onChange={(next) => {
        setDraft(next);
        // A failed send, or the flagged chip once it is right, stops being shown.
        if (error?.kind === 'request') setError(null);
        else if (error?.kind === 'chip') {
          const chip = next.chips.find((c) => c.option.name === error.name);
          if (!chip || chipError(chip) === null) setError(null);
        }
      }}
      onCancel={cancel}
      onSubmit={submit}
    />
  ) : null;
  let footer: ReactNode = null;
  if (draft && error) {
    footer = (
      <p className={b.draftError} role="alert">
        {error.kind === 'chip' ? chipErrorText(t, error.name, error.error) : t('slash.failed', { reason: errorMessage(t, error.code) })}
      </p>
    );
  } else if (draft) {
    footer = <p className={b.draftHint}>{t('slash.hint')}</p>;
  }

  return { draft, open, listId, active, busy, onTextKeyDown, submit, picker, box, footer };
}
