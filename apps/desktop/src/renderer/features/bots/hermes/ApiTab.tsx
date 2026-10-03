import { useState, type FormEvent } from 'react';
import { API_ENV_ALLOWED_SUFFIXES, FEATURE_ENTERPRISE_APIS, HERMES_LIMITS, type HermesState } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../../i18n/index.js';
import { ConfirmDialog, ErrorText, primitives as p } from '../../../layout/primitives.js';
import s from '../../../layout/settings.module.css';
import { useConnectionStore } from '../../../stores/connection.js';
import g from '../botPage.module.css';
import { apiPatch, apiRows, newApiPatch, otherApiProblem, savedKeys, type ApiGroup, type ApiRow } from './apiModel.js';
import { updateHermes } from './hermesActions.js';
import h from './hermes.module.css';

const GROUPS: readonly ApiGroup[] = ['ai', 'other', 'custom'];
const TEST_TEXT = { ok: 'hermes.api.test.ok', refused: 'hermes.api.test.refused', unreachable: 'hermes.api.test.unreachable' } as const;

/**
 * API (spec 2026-10-03-aba-api-e-sites-design.md §1), the company Hermes page's 6th tab, the owner's
 * only: the catalog's AIs and other APIs, then the owner's own, each "configurada (final 1234)" or
 * "não configurada" with Trocar and Apagar, the AIs with their key test; then "Outra API". Saves through
 * hermes.update (the answer and hermes.state refresh it); a key typed here is never kept.
 */
export function ApiTab({ state }: { state: HermesState }) {
  const t = useT();
  const full = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_ENTERPRISE_APIS) === true);
  const rows = apiRows(state, full);
  const atLimit = savedKeys(state) >= HERMES_LIMITS.maxApis;
  return (
    <section aria-label={t('hermes.page.tab.api')} className={h.apiPanel} data-hermes-api>
      <p className={h.pageEmpty}>{t('hermes.api.intro')}</p>
      {!full && <p className={h.pageEmpty}>{t('hermes.api.oldServer')}</p>}
      {GROUPS.map((group) => {
        const list = rows.filter((r) => r.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`hermes-api-${group}`}>
            <h2 id={`hermes-api-${group}`} className={g.sectionTitle}>
              {t(`hermes.api.group.${group}`)}
            </h2>
            <ul className={h.apiList}>
              {list.map((row) => (
                <ApiRowItem key={row.envVar} row={row} locked={state.locked} atLimit={atLimit} />
              ))}
            </ul>
          </section>
        );
      })}
      {full && <OtherApiForm state={state} />}
    </section>
  );
}

function ApiRowItem({ row, locked, atLimit }: { row: ApiRow; locked: boolean; atLimit: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const empty = row.last4 === null;
  const save = async (key: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await updateHermes(apiPatch(row, key));
      setEditing(false);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setValue(''); // write-only: a key typed here is gone once the save ends, whatever its result
      setBusy(false);
    }
  };
  const blocked = busy || locked || (empty && atLimit);
  return (
    <li className={h.apiRow} data-hermes-api-row={row.envVar}>
      <div className={h.apiHead}>
        <span className={h.apiName}>{row.name}</span>
        <code className={h.apiVar}>{row.envVar}</code>
        <span className={h.factMuted}>{empty ? t('hermes.keys.none') : t('hermes.keys.set', { last4: row.last4! })}</span>
        {row.test !== null && (
          <span className={row.test === 'ok' ? h.apiTestOk : h.apiTestBad} data-hermes-api-test={row.test}>
            {t(TEST_TEXT[row.test])}
          </span>
        )}
      </div>
      {empty || editing ? (
        <form
          className={s.row}
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value);
          }}
        >
          <input
            className={s.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={HERMES_LIMITS.keyMax}
            aria-label={`${row.name}: ${t('hermes.api.key')}`}
            placeholder={t('hermes.keys.paste')}
            value={value}
            disabled={blocked}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={blocked || value.trim() === ''}>
            {t('hermes.keys.save')}
          </button>
          {editing && (
            <button type="button" className={p.button} disabled={busy} onClick={() => { setEditing(false); setValue(''); }}>
              {t('common.cancel')}
            </button>
          )}
        </form>
      ) : (
        <div className={s.row}>
          <button type="button" className={p.button} disabled={locked} onClick={() => setEditing(true)}>
            {t('hermes.keys.change')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled={locked} onClick={() => setConfirming(true)}>
            {t('hermes.keys.delete')}
          </button>
        </div>
      )}
      {error && <ErrorText code={error} />}
      {confirming && (
        <ConfirmDialog
          title={t('hermes.api.deleteTitle', { name: row.name })}
          body={t('hermes.api.deleteBody', { name: row.name })}
          confirmLabel={t('hermes.keys.delete')}
          onConfirm={() => save(null)}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

function OtherApiForm({ state }: { state: HermesState }) {
  const t = useT();
  const [name, setName] = useState('');
  const [envVar, setEnvVar] = useState('');
  const [key, setKey] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = otherApiProblem(state, { name, envVar, key });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      await updateHermes(newApiPatch({ name, envVar, key }));
      setName('');
      setEnvVar('');
      setTried(false);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setKey(''); // write-only: never kept after the save
      setBusy(false);
    }
  };
  const disabled = busy || state.locked;
  return (
    <section aria-labelledby="hermes-api-new">
      <h2 id="hermes-api-new" className={g.sectionTitle}>
        {t('hermes.api.other')}
      </h2>
      <p className={h.pageEmpty}>{t('hermes.api.otherHint')}</p>
      <p className={h.pageEmpty}>{t('hermes.api.suffixHint', { endings: API_ENV_ALLOWED_SUFFIXES.join(', ') })}</p>
      <form className={h.apiForm} onSubmit={(e) => void submit(e)} data-hermes-api-new>
        <input className={s.input} aria-label={t('hermes.api.name')} placeholder={t('hermes.api.name')} maxLength={HERMES_LIMITS.apiNameMax} value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        <input
          className={`${s.input} ${h.apiVarInput}`}
          aria-label={t('hermes.api.envVar')}
          placeholder={t('hermes.api.envVarExample')}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          value={envVar}
          disabled={disabled}
          onChange={(e) => setEnvVar(e.target.value.toUpperCase())}
        />
        <input className={s.input} type="password" aria-label={t('hermes.api.key')} placeholder={t('hermes.keys.paste')} maxLength={HERMES_LIMITS.keyMax} autoComplete="off" spellCheck={false} value={key} disabled={disabled} onChange={(e) => setKey(e.target.value)} />
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={disabled}>
          {t('hermes.api.add')}
        </button>
      </form>
      {tried && problem !== null && (
        <p className={p.error} role="alert">
          {t(`hermes.api.problem.${problem}`)}
        </p>
      )}
      {error && <ErrorText code={error} />}
    </section>
  );
}
