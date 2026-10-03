import { useId, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  FEATURE_ENTERPRISE_HERMES_VIEW,
  HERMES_LIMITS,
  type HermesMemoryItem,
  type HermesMemoryTarget,
  type HermesModelRef,
  type HermesProvider,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import { errorCodeOf, useT, type Translate } from '../../../i18n/index.js';
import { ErrorText, Select, primitives as p } from '../../../layout/primitives.js';
import s from '../../../layout/settings.module.css';
import type { SettingsTab } from '../../../layout/SettingsShell.js';
import { useConnectionStore } from '../../../stores/connection.js';
import { useEnterpriseStore } from '../../../stores/enterprise.js';
import { rolesByPosition } from '../../../stores/server.js';
import { sortedChannels } from '../../../stores/channels.js';
import { useSettingsStore } from '../../../stores/settings.js';
import { useTextStore } from '../../../stores/text.js';
import { useNow } from '../BotParts.js';
import { timeAgo } from '../botsModel.js';
import { deleteHermesMemory, updateHermes } from './hermesActions.js';
import { PROVIDER_NAMES, initialModels, modelsSaveable, providersWithKeys, skillEnabled, statusLines, toggledSkills } from './hermesModel.js';
import h from './hermes.module.css';

const DOT = { ok: h.dotOk, warn: h.dotWarn, error: h.dotError } as const;
const MODEL_SUGGESTIONS = ['deepseek-v4-pro', 'deepseek-flash', 'deepseek/deepseek-v4-pro'];

/** The four tabs of the company Hermes's settings, in the bot's settings (the owner only). */
export function hermesSettingsTabs(t: Translate): SettingsTab[] {
  const tab = (id: string, content: (state: HermesState) => ReactNode): SettingsTab => ({
    id,
    label: t(`hermes.tab.${id.slice('hermes'.length).toLowerCase()}` as 'hermes.tab.models'),
    content: () => <HermesTab render={content} />,
  });
  return [
    tab('hermesModels', (state) => <ModelsTab state={state} />),
    tab('hermesSkills', (state) => <SkillsTab state={state} />),
    tab('hermesAccess', (state) => <AccessTab state={state} />),
    tab('hermesMemory', (state) => <MemoryTab state={state} />),
  ];
}

/** The state from the store (so a hermes.state event refreshes it), under the status lines. */
function HermesTab({ render }: { render: (state: HermesState) => ReactNode }) {
  const state = useEnterpriseStore((st) => st.hermes);
  if (!state) return null;
  return (
    <div className={s.form}>
      <HermesStatus state={state} />
      {render(state)}
    </div>
  );
}

function HermesStatus({ state }: { state: HermesState }) {
  const t = useT();
  return (
    <ul className={h.status} data-hermes-status>
      {statusLines(state).map((line) => (
        <li key={`${line.key}-${JSON.stringify(line.vars ?? {})}`} className={h.statusLine}>
          <span className={`${h.dot} ${DOT[line.tone]}`} aria-hidden="true" />
          {t(line.key, line.vars)}
        </li>
      ))}
    </ul>
  );
}

/** Runs a save: busy, the error, "Salvo". */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async (job: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await job();
      setDone(true);
      return true;
    } catch (e) {
      setError(errorCodeOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run, reset: () => setDone(false) };
}

function SaveResult({ error, done }: { error: string | null; done: boolean }) {
  const t = useT();
  return (
    <>
      {error && <ErrorText code={error} />}
      {done && <p className={s.ok}>{t('hermes.saved')}</p>}
    </>
  );
}

// ---- Modelos ----

function ModelsTab({ state }: { state: HermesState }) {
  const t = useT();
  const providers = providersWithKeys(state);
  const listId = useId();
  const [primary, setPrimary] = useState<HermesModelRef>(() => initialModels(state).primary);
  const [fallback, setFallback] = useState<HermesModelRef | null>(() => initialModels(state).fallback);
  const save = useSave();
  if (providers.length === 0) return <p className={s.hint}>{t('hermes.models.noKeys')}</p>;
  const options = providers.map((value) => ({ value, label: PROVIDER_NAMES[value] }));
  const fallbackOptions = [{ value: 'none', label: t('hermes.models.noFallback') }, ...options];
  const disabled = save.busy || state.locked;
  return (
    <>
      <p className={p.text}>{t('hermes.models.intro')}</p>
      <datalist id={listId}>
        {MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <ModelField
        title={t('hermes.models.primary')}
        listId={listId}
        value={primary}
        options={options}
        disabled={disabled}
        onChange={(v) => {
          if (v) setPrimary(v);
          save.reset();
        }}
      />
      <ModelField
        title={t('hermes.models.fallback')}
        listId={listId}
        value={fallback}
        options={fallbackOptions}
        disabled={disabled}
        onChange={(v) => {
          setFallback(v);
          save.reset();
        }}
      />
      <SaveResult error={save.error} done={save.done} />
      <div className={s.row}>
        <button
          type="button"
          className={`${p.button} ${p.buttonPrimary}`}
          disabled={disabled || !modelsSaveable(providers, primary, fallback)}
          onClick={() => void save.run(() => updateHermes({ models: { primary: { ...primary, model: primary.model.trim() }, fallback: fallback && { ...fallback, model: fallback.model.trim() } } }))}
        >
          {t('hermes.models.save')}
        </button>
      </div>
    </>
  );
}

/** A provider `Select` and the model's id; `value` null (fallback only) is "Sem reserva". */
function ModelField({
  title,
  listId,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string;
  listId: string;
  value: HermesModelRef | null;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: HermesModelRef | null) => void;
}) {
  const t = useT();
  const labelId = useId();
  const inputId = useId();
  return (
    <div className={s.field}>
      <span id={labelId} className={s.label}>
        {title}
      </span>
      <div className={h.modelRow}>
        <Select
          value={value?.provider ?? 'none'}
          options={options}
          disabled={disabled}
          label={`${title}: ${t('hermes.models.provider')}`}
          onChange={(v) => {
            if (v === 'none') onChange(null);
            else onChange({ provider: v as HermesProvider, model: value?.model ?? '' });
          }}
        />
        {value && (
          <input
            id={inputId}
            className={s.input}
            list={listId}
            aria-label={`${title}: ${t('hermes.models.model')}`}
            autoComplete="off"
            spellCheck={false}
            maxLength={HERMES_LIMITS.modelMax}
            value={value.model}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

// ---- Skills ----

function SkillsTab({ state }: { state: HermesState }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const now = useNow();
  const save = useSave();
  const skills = state.report?.skills ?? [];
  return (
    <>
      <p className={p.text}>{t('hermes.skills.intro')}</p>
      {!state.connected && state.reportAt !== null && <p className={s.hint}>{t('hermes.skills.lastSeen', { time: timeAgo(state.reportAt, now, locale) })}</p>}
      {skills.length === 0 ? (
        <p className={s.hint}>{t('hermes.skills.none')}</p>
      ) : (
        <ul className={h.list}>
          {skills.map((skill) => (
            <li key={skill.name} className={h.item}>
              <label className={s.check} title={skill.locked ? t('hermes.skills.locked') : undefined} data-hermes-skill={skill.name}>
                <input
                  type="checkbox"
                  checked={skillEnabled(state, skill)}
                  disabled={skill.locked || state.locked || save.busy}
                  onChange={(e) => void save.run(() => updateHermes({ disabledSkills: toggledSkills(state, skill.name, e.target.checked) }))}
                />
                <span>
                  <span className={h.skillName}>{skill.name}</span>
                  {skill.description && <span className={h.skillDescription}>{skill.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <SaveResult error={save.error} done={save.done} />
    </>
  );
}

// ---- Quem pode usar ----

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  const next = list.filter((x) => x !== id);
  return on ? [...next, id] : next;
}

/** Only what changed: the viewer role alone sends the Hermes nothing (spec 2026-10-03 §3). */
function accessPatch(state: HermesState, access: HermesState['settings']['access'], viewerRoleId: string | null, viewerSupported: boolean): HermesUpdatePayload {
  const patch: HermesUpdatePayload = {};
  if (JSON.stringify(access) !== JSON.stringify(state.settings.access)) patch.access = access;
  if (viewerSupported && viewerRoleId !== state.viewerRoleId) patch.viewerRoleId = viewerRoleId;
  return patch;
}

function AccessTab({ state }: { state: HermesState }) {
  const t = useT();
  const roles = useTextStore((st) => st.server.roles);
  const channels = useTextStore((st) => st.channels.byId);
  const viewerSupported = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_ENTERPRISE_HERMES_VIEW) === true);
  const [roleIds, setRoleIds] = useState<string[]>(state.settings.access.roleIds);
  const [chosen, setChosen] = useState<string[] | null>(state.settings.access.channels === 'all' ? null : state.settings.access.channels);
  const [viewer, setViewer] = useState<string>(state.viewerRoleId ?? 'none');
  const save = useSave();
  const disabled = save.busy || state.locked;
  const roleList = rolesByPosition(roles).filter((r) => !r.isDefault);
  const textChannels = sortedChannels(channels, 'text');
  const edit = () => save.reset();
  // The saved role may have been deleted meanwhile (the server resets it): "Nenhum".
  const viewerShown = viewer !== 'none' && Object.hasOwn(roles, viewer) ? viewer : 'none';
  const submit = async () => {
    const patch = accessPatch(state, { roleIds, channels: chosen ?? 'all' }, viewerShown === 'none' ? null : viewerShown, viewerSupported);
    await save.run(async () => {
      if (Object.keys(patch).length > 0) await updateHermes(patch);
    });
  };
  return (
    <>
      <section className={h.block}>
        <h4 className={h.blockTitle}>{t('hermes.access.roles')}</h4>
        <p className={s.hint}>{t('hermes.access.rolesHint')}</p>
        {roleList.map((role) => (
          <label key={role.id} className={s.check} data-hermes-role={role.name}>
            <input
              type="checkbox"
              checked={roleIds.includes(role.id)}
              disabled={disabled}
              onChange={(e) => {
                setRoleIds(toggle(roleIds, role.id, e.target.checked));
                edit();
              }}
            />
            <span>{role.name}</span>
          </label>
        ))}
      </section>
      <section className={h.block}>
        <h4 className={h.blockTitle}>{t('hermes.access.channels')}</h4>
        <label className={s.check}>
          <input
            type="radio"
            name="hermes-channels"
            checked={chosen === null}
            disabled={disabled}
            onChange={() => {
              setChosen(null);
              edit();
            }}
          />
          <span>{t('hermes.access.all')}</span>
        </label>
        <label className={s.check}>
          <input
            type="radio"
            name="hermes-channels"
            checked={chosen !== null}
            disabled={disabled}
            onChange={() => {
              setChosen(chosen ?? []);
              edit();
            }}
          />
          <span>{t('hermes.access.chosen')}</span>
        </label>
        {chosen !== null &&
          textChannels.map((c) => (
            <label key={c.id} className={s.check} data-hermes-channel={c.name}>
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                disabled={disabled}
                onChange={(e) => {
                  setChosen(toggle(chosen, c.id, e.target.checked));
                  edit();
                }}
              />
              <span># {c.name}</span>
            </label>
          ))}
      </section>
      <p className={s.hint}>{t('hermes.access.mentionHint')}</p>
      {viewerSupported && (
        <section className={h.block} data-hermes-viewer>
          <h4 className={h.blockTitle}>{t('hermes.access.viewer')}</h4>
          <p className={s.hint}>{t('hermes.access.viewerHint')}</p>
          <Select
            value={viewerShown}
            options={[{ value: 'none', label: t('hermes.access.viewerNone') }, ...roleList.map((r) => ({ value: r.id, label: r.name }))]}
            disabled={disabled}
            label={t('hermes.access.viewer')}
            onChange={(v) => {
              setViewer(v);
              edit();
            }}
          />
        </section>
      )}
      <SaveResult error={save.error} done={save.done} />
      <div className={s.row}>
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled={disabled} onClick={() => void submit()}>
          {t('hermes.access.save')}
        </button>
      </div>
    </>
  );
}

// ---- Memória ----

function MemoryTab({ state }: { state: HermesState }) {
  const t = useT();
  const memory = state.report?.memory;
  return (
    <>
      <p className={p.text}>{t('hermes.memory.intro')}</p>
      <MemoryList title={t('hermes.memory.company')} target="company" items={memory?.company ?? []} connected={state.connected && !state.locked} />
      <MemoryList title={t('hermes.memory.people')} target="people" items={memory?.people ?? []} connected={state.connected && !state.locked} />
    </>
  );
}

function MemoryList({ title, target, items, connected }: { title: string; target: HermesMemoryTarget; items: HermesMemoryItem[]; connected: boolean }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteHermesMemory(target, id);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={h.block} data-hermes-memory={target}>
      <h4 className={h.blockTitle}>{title}</h4>
      {items.length === 0 ? (
        <p className={s.hint}>{t('hermes.memory.empty')}</p>
      ) : (
        <ul className={h.list}>
          {items.map((item) => (
            <li key={item.id} className={h.item}>
              <span className={h.itemText}>{item.text}</span>
              <button type="button" className={h.trash} aria-label={t('hermes.memory.delete')} title={t('hermes.memory.delete')} disabled={!connected || busy} onClick={() => void remove(item.id)}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorText code={error} />}
    </section>
  );
}
