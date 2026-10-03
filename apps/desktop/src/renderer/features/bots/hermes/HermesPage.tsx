import { useEffect, useMemo, type ReactNode } from 'react';
import { Building2, Hash } from 'lucide-react';
import type { HermesView } from '@ghostlink/shared';
import { useT } from '../../../i18n/index.js';
import { primitives as p } from '../../../layout/primitives.js';
import { useTextStore } from '../../../stores/text.js';
import { openBotSettings } from '../botSettingsLink.js';
import g from '../botPage.module.css';
import { refreshHermesView } from './hermesActions.js';
import { hermesPageBlocks } from './hermesPageModel.js';
import h from './hermes.module.css';

/**
 * The company Hermes on its page (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md §2), for the
 * owner and the viewer role: the "Hermes da empresa" badge, then Situação e modelo, Skills, Onde e
 * quem usa and (the owner only) Memória, whose "Abrir" opens that tab of the settings. Read only;
 * `hermes.view` events keep it live.
 */
export function HermesPage({ view }: { view: HermesView }) {
  const t = useT();
  const roles = useTextStore((st) => st.server.roles);
  const channels = useTextStore((st) => st.channels.byId);
  const b = useMemo(() => hermesPageBlocks(view, { roles, channels }), [view, roles, channels]);
  const botId = view.botId;
  useEffect(() => {
    void refreshHermesView();
  }, [botId]);

  return (
    <>
      <p className={h.pageBadge} data-hermes-page>
        <Building2 size={14} aria-hidden="true" />
        {t('hermes.page.badge')}
      </p>

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

      <Block id="hermes-page-skills" title={b.skills === null ? t('hermes.tab.skills') : `${t('hermes.tab.skills')} — ${b.skills.length}`}>
        {b.skills === null || b.skills.length === 0 ? (
          <p className={h.pageEmpty}>{b.skills === null ? t('hermes.skills.none') : t('hermes.page.skillsNone')}</p>
        ) : (
          <ul className={h.list}>
            {b.skills.map((skill) => (
              <li key={skill.name} className={h.item} data-hermes-page-skill={skill.name}>
                <span>
                  <span className={h.skillName}>{skill.name}</span>
                  {skill.description && <span className={h.skillDescription}>{skill.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

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

      {b.memory !== undefined && botId !== null && (
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
    </>
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
