import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Building2, Hash } from 'lucide-react';
import type { HermesView } from '@ghostlink/shared';
import { useT } from '../../../i18n/index.js';
import { primitives as p } from '../../../layout/primitives.js';
import { useEnterpriseStore } from '../../../stores/enterprise.js';
import { useTextStore } from '../../../stores/text.js';
import { openBotSettings } from '../botSettingsLink.js';
import g from '../botPage.module.css';
import { ApiTab } from './ApiTab.js';
import { refreshHermesView } from './hermesActions.js';
import { filterSkills, hermesPageBlocks, hermesPageTabs, pageSkillRows, type HermesPageTab, type SkillFilter, type SkillRow } from './hermesPageModel.js';
import h from './hermes.module.css';

/**
 * The company Hermes on its page (specs 2026-10-03 pagina-do-hermes-da-empresa and
 * pagina-larga-e-abas), for the owner and the viewer role: the "Hermes da empresa" badge, then six
 * tabs (Visão geral, Skills, Acesso, Memória and API for the owner only, Comandos). Read only; `hermes.view`
 * events keep the open tab live. The caller keys it by server and bot, so the tab goes back to
 * Visão geral on a change. `overview` goes under the status; `commands` is the bot's command list.
 */
export function HermesPage({ view, overview, commands }: { view: HermesView; overview?: ReactNode; commands: ReactNode }) {
  const t = useT();
  const roles = useTextStore((st) => st.server.roles);
  const channels = useTextStore((st) => st.channels.byId);
  const state = useEnterpriseStore((st) => st.hermes);
  const b = useMemo(() => hermesPageBlocks(view, { roles, channels }), [view, roles, channels]);
  const botId = view.botId;
  // The owner's full state (null for the viewer role): only they see the off skills and Memória.
  const owner = b.memory !== undefined;
  const ownState = owner && state !== null && state.botId === botId ? state : null;
  const rows = useMemo(() => pageSkillRows(view, ownState), [view, ownState]);
  const tabs = hermesPageTabs(owner);
  const [picked, setPicked] = useState<HermesPageTab>('overview');
  const tab = tabs.includes(picked) ? picked : 'overview';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('on');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void refreshHermesView();
  }, [botId]);

  const label = (id: HermesPageTab): string => {
    if (id === 'skills') return `${t('hermes.tab.skills')} ${(rows ?? []).filter((r) => r.enabled).length}`;
    if (id === 'overview') return t('hermes.page.tab.overview');
    if (id === 'access') return t('hermes.page.tab.access');
    if (id === 'memory') return t('hermes.tab.memory');
    if (id === 'api') return t('hermes.page.tab.api');
    return t('bots.page.commands');
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const index = tabs.indexOf(tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setPicked(tabs[next]!);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <>
      <p className={h.pageBadge} data-hermes-page>
        <Building2 size={14} aria-hidden="true" />
        {t('hermes.page.badge')}
      </p>

      <div ref={listRef} className={h.pageTabs} role="tablist" aria-label={t('hermes.page.tabs')} onKeyDown={onKeyDown}>
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`hermes-page-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="hermes-page-panel"
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? `${h.pageTab} ${h.pageTabSelected}` : h.pageTab}
            onClick={() => setPicked(id)}
            data-hermes-page-tab={id}
          >
            {label(id)}
          </button>
        ))}
      </div>

      <div id="hermes-page-panel" role="tabpanel" aria-labelledby={`hermes-page-tab-${tab}`} className={h.pagePanel}>
        {tab === 'overview' && (
          <>
            <Block id="hermes-page-situation" title={t('hermes.page.situation')}>
              <div className={h.card}>
                <p className={g.status} data-hermes-page-connection>
                  <span className={b.connected ? `${g.statusDot} ${g.statusOn}` : g.statusDot} aria-hidden="true" />
                  {b.connected ? t('hermes.page.connected') : t('hermes.page.disconnected')}
                </p>
                <dl className={h.facts}>
                  <dt>{t('hermes.page.primary')}</dt>
                  <dd data-hermes-page-primary>{b.primary}</dd>
                  <dt>{t('hermes.page.fallback')}</dt>
                  <dd data-hermes-page-fallback>{b.fallback ?? t('hermes.page.noFallback')}</dd>
                  {b.inUse !== null && (
                    <>
                      <dt>{t('hermes.page.inUse')}</dt>
                      <dd data-hermes-page-in-use>{b.inUse}</dd>
                    </>
                  )}
                </dl>
              </div>
            </Block>
            {overview}
          </>
        )}

        {tab === 'skills' && <SkillsPanel rows={rows} owner={owner} botId={botId} query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} />}

        {tab === 'access' && (
          <Block id="hermes-page-where" title={t('hermes.page.where')}>
            <div className={h.card}>
              <div className={h.fact}>
                <span className={h.factLabel}>{t('hermes.page.channels')}</span>
                {b.channels.all ? (
                  <span data-hermes-page-channels="all">{t('hermes.access.all')}</span>
                ) : (
                  <span className={h.chips} data-hermes-page-channels>
                    {b.channels.names.map((name, i) => (
                      <span key={`${i}-${name}`} className={h.chip}>
                        <Hash size={12} aria-hidden="true" />
                        {name}
                      </span>
                    ))}
                    {b.channels.hidden > 0 && <span className={h.factMuted}>{t(b.channels.hidden === 1 ? 'hermes.page.hidden.one' : 'hermes.page.hidden.other', { n: b.channels.hidden })}</span>}
                    {b.channels.names.length === 0 && b.channels.hidden === 0 && <span className={h.factMuted}>{t('hermes.page.noChannels')}</span>}
                  </span>
                )}
              </div>
              <div className={h.fact}>
                <span className={h.factLabel}>{t('hermes.page.roles')}</span>
                <span className={h.chips} data-hermes-page-roles>
                  {b.roles.map((name, i) => (
                    <span key={`${i}-${name}`} className={h.chip}>
                      {name}
                    </span>
                  ))}
                  <span className={h.chip}>{t('hermes.page.owner')}</span>
                </span>
              </div>
            </div>
          </Block>
        )}

        {tab === 'memory' && b.memory !== undefined && botId !== null && (
          <Block id="hermes-page-memory" title={t('hermes.tab.memory')}>
            <div className={`${h.card} ${h.memoryRow}`}>
              <p className={h.memoryText} data-hermes-page-memory>
                {b.memory === null
                  ? t('hermes.page.memoryNone')
                  : `${t(b.memory.company === 1 ? 'hermes.page.memoryCompany.one' : 'hermes.page.memoryCompany.other', { n: b.memory.company })} · ${t('hermes.page.memoryPeople', { n: b.memory.people })}`}
              </p>
              <button type="button" className={p.button} onClick={() => openBotSettings(botId, 'hermesMemory')} data-hermes-page-open-memory>
                {t('hermes.page.open')}
              </button>
            </div>
          </Block>
        )}

        {tab === 'api' && ownState !== null && <ApiTab state={ownState} />}

        {tab === 'commands' && commands}
      </div>
    </>
  );
}

/** Skills N: search, the compact grid, and for the owner the Ligadas | Todas filter and "Gerenciar skills". */
function SkillsPanel({ rows, owner, botId, query, onQuery, filter, onFilter }: { rows: SkillRow[] | null; owner: boolean; botId: string | null; query: string; onQuery: (q: string) => void; filter: SkillFilter; onFilter: (f: SkillFilter) => void }) {
  const t = useT();
  const shown = useMemo(() => filterSkills(rows ?? [], owner ? filter : 'on', query), [rows, owner, filter, query]);
  return (
    <section aria-label={t('hermes.tab.skills')} className={h.skillsPanel}>
      <div className={h.skillsBar}>
        <input type="search" className={h.skillsSearch} placeholder={t('hermes.page.skillsSearch')} aria-label={t('hermes.page.skillsSearch')} value={query} onChange={(e) => onQuery(e.target.value)} data-hermes-page-skills-search />
        {owner && (
          <div className={h.segment} role="group" aria-label={t('hermes.page.filter')}>
            {(['on', 'all'] as const).map((id) => (
              <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? `${h.segmentButton} ${h.segmentOn}` : h.segmentButton} onClick={() => onFilter(id)} data-hermes-page-filter={id}>
                {t(id === 'on' ? 'hermes.page.filter.on' : 'hermes.page.filter.all')}
              </button>
            ))}
          </div>
        )}
        {owner && botId !== null && (
          <button type="button" className={p.button} onClick={() => openBotSettings(botId, 'hermesSkills')} data-hermes-page-manage-skills>
            {t('hermes.page.manageSkills')}
          </button>
        )}
      </div>
      {rows === null || rows.length === 0 ? (
        <p className={h.pageEmpty}>{rows === null ? t('hermes.skills.none') : t('hermes.page.skillsNone')}</p>
      ) : shown.length === 0 ? (
        <p className={h.pageEmpty}>{t('hermes.page.skillsNoMatch')}</p>
      ) : (
        <ul className={h.skillGrid}>
          {shown.map((skill) => (
            <li key={skill.name} className={skill.enabled ? h.skillCard : `${h.skillCard} ${h.skillCardOff}`} data-hermes-page-skill={skill.name} data-hermes-page-skill-off={skill.enabled ? undefined : ''}>
              <span className={h.skillName}>
                {skill.name}
                {!skill.enabled && <span className={h.skillOffTag}>{t('hermes.page.skillOff')}</span>}
              </span>
              {skill.description && <span className={h.skillDescriptionClamp}>{skill.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={g.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}
