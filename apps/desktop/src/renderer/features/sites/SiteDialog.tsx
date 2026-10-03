import { useMemo, useState, type FormEvent } from 'react';
import { SITE_LIMITS, normalizeSiteDomain, type Site } from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, Modal, Select, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { dispatchText, useTextStore } from '../../stores/text.js';
import { createSite, registerChannelsAsSites, updateSite } from './siteActions.js';
import { freeTextChannels, siteFormProblem, siteLikeChannels } from './siteModel.js';

const NEW_CHANNEL = 'new';

/**
 * "Cadastrar site" (spec 2026-10-03-aba-api-e-sites §2): name, address and channel (an existing text
 * channel, or "Criar canal novo" named after the address); above it, the channels named like a site with
 * "Cadastrar como sites" (plan decision 3). With `site`: "Editar site", name and address only.
 */
export function SiteDialog({ site, onClose }: { site?: Site; onClose: () => void }) {
  const t = useT();
  const byId = useTextStore((st) => st.channels.byId);
  const sites = useEnterpriseStore((st) => st.sites);
  const free = useMemo(() => freeTextChannels(byId, sites), [byId, sites]);
  const likely = useMemo(() => (site ? [] : siteLikeChannels(byId, sites)), [site, byId, sites]);
  const [name, setName] = useState(site?.name ?? '');
  const [domain, setDomain] = useState(site?.domain ?? '');
  const [channelId, setChannelId] = useState<string>(NEW_CHANNEL);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = siteFormProblem({ name, domain, creating: site === undefined, count: sites.length });

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      onClose();
    } catch (e) {
      setError(errorCodeOf(e));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem !== null) return;
    const clean = normalizeSiteDomain(domain)!;
    void run(async () => {
      if (site) {
        await updateSite(site.id, { name: name.trim(), domain: clean });
        return;
      }
      const created = await createSite({ name: name.trim(), domain: clean, channelId: channelId === NEW_CHANNEL ? null : channelId });
      dispatchText({ type: 'select', channelId: created.channelId });
    });
  };
  const options = [{ value: NEW_CHANNEL, label: t('sites.newChannel') }, ...free.map((c) => ({ value: c.id, label: `# ${c.name}` }))];

  return (
    <Modal
      title={site ? t('sites.editTitle', { name: site.name }) : t('sites.createTitle')}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button type="button" className={p.button} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="site-form" className={`${p.button} ${p.buttonPrimary}`} disabled={busy}>
            {site ? t('sites.save') : t('sites.create')}
          </button>
        </>
      }
    >
      {likely.length > 0 && (
        <section className={s.field} data-sites-likely>
          <span className={s.label}>{t('sites.likely', { n: likely.length })}</span>
          <p className={s.hint}>{likely.map((c) => `# ${c.name}`).join(' · ')}</p>
          <div className={s.row}>
            <button type="button" className={p.button} disabled={busy || sites.length + likely.length > SITE_LIMITS.maxSites} onClick={() => void run(() => registerChannelsAsSites(likely))}>
              {t('sites.registerLikely')}
            </button>
          </div>
        </section>
      )}
      <form id="site-form" className={s.form} onSubmit={submit}>
        <label className={s.field}>
          <span className={s.label}>{t('sites.name')}</span>
          <input className={s.input} value={name} maxLength={SITE_LIMITS.nameMax} placeholder={t('sites.nameExample')} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className={s.field}>
          <span className={s.label}>{t('sites.domain')}</span>
          <input className={s.input} value={domain} maxLength={300} placeholder={t('sites.domainExample')} spellCheck={false} onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
          <span className={s.hint}>{t('sites.domainHint')}</span>
        </label>
        {!site && (
          <div className={s.field}>
            <span className={s.label} id="site-channel-label">
              {t('sites.channel')}
            </span>
            <Select value={channelId} options={options} onChange={setChannelId} labelledBy="site-channel-label" disabled={busy} />
            <span className={s.hint}>{t(channelId === NEW_CHANNEL ? 'sites.newChannelHint' : 'sites.moveHint')}</span>
          </div>
        )}
        {tried && problem !== null && (
          <p className={p.error} role="alert">
            {t(`sites.problem.${problem}`)}
          </p>
        )}
        {error && <ErrorText code={error} />}
      </form>
    </Modal>
  );
}
