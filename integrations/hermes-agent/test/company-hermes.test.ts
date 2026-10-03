// The company Hermes end to end (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §6, and
// 2026-10-03-aba-api-e-sites-design.md §5): a real server with the enterprise, companyHermes and sites
// modules, the plugin's own code (company_e2e.py) on a scratch HERMES_HOME, and the owner's requests
// exactly as the app sends them. Skipped without Python with aiohttp, cryptography and ruamel.yaml
// (GHOSTLINK_TEST_PYTHON picks the interpreter; CI's Linux job has them).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotCreateResult, HermesState, Site } from '@ghostlink/shared';
import { createAvatarsModule } from '../../../apps/server/src/avatars/index.js';
import { createBotsModule } from '../../../apps/server/src/bots/index.js';
import { createCompanyHermesModule } from '../../../apps/server/src/companyHermes/index.js';
import { createEnterpriseModule } from '../../../apps/server/src/enterprise/index.js';
import { createSitesModule } from '../../../apps/server/src/sites/index.js';
import { testLicenseKey } from '../../../apps/server/test/helpers/license.js';
import { textFixture } from '../../../apps/server/test/text/helpers.js';

const SCRIPT = fileURLToPath(new URL('./company_e2e.py', import.meta.url));
const DAY = 86_400_000;

function findPython(): string | null {
  const candidates = process.env.GHOSTLINK_TEST_PYTHON ? [process.env.GHOSTLINK_TEST_PYTHON] : ['python3', 'python'];
  for (const python of candidates) {
    if (spawnSync(python, ['-c', 'import aiohttp, cryptography, ruamel.yaml'], { stdio: 'ignore' }).status === 0) return python;
  }
  return null;
}
const PYTHON = findPython();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ghostlink-hermes-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  writeFileSync(join(home, 'config.yaml'), '# TC Hermes (teste)\nmodel:\n  provider: deepseek\n  default: deepseek-v4-pro\nfallback_model:\n  provider: openrouter\n  model: deepseek/deepseek-v4-pro\n');
  for (const [dir, name] of [['hermes-agent', 'hermes-agent'], ['geral/resumo', 'resumo']] as const) {
    mkdirSync(join(home, 'skills', dir), { recursive: true });
    writeFileSync(join(home, 'skills', dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Uma skill\n---\n`);
  }
  mkdirSync(join(home, 'memories'));
  writeFileSync(join(home, 'memories', 'MEMORY.md'), 'A TC Flag fabrica bandeiras.\n§\nO estoque fica em Guarulhos.');
  return home;
}

function runHermes(code: string, home: string) {
  const child: ChildProcess = spawn(PYTHON!, [SCRIPT], { env: { ...process.env, GHOSTLINK_BOT: code, HERMES_HOME: home, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' } });
  // Killed before the scratch home is removed (cleanups run in order).
  cleanups.unshift(() => child.kill());
  let stderr = '';
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()));
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  // Every line stays: "ready" and the first hermes.config may arrive in either order.
  const seen: Record<string, unknown>[] = [];
  return {
    async until(pred: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const earlier = seen.find(pred);
      if (earlier) return earlier;
      for (;;) {
        const next = await lines.next();
        if (next.done) throw new Error(`company_e2e.py ended:\n${stderr}`);
        const line = JSON.parse(next.value) as Record<string, unknown>;
        seen.push(line);
        if (pred(line)) return line;
      }
    },
  };
}

describe.skipIf(PYTHON === null)('the company Hermes, end to end (spec §6)', () => {
  it("the owner changes the model, a key and the access, adds a key of the owner's own and a site; the Hermes applies them and the panel shows it; a memory item goes", async () => {
    const key = testLicenseKey();
    const fx = await textFixture({
      extraModules: [createAvatarsModule(), createBotsModule(), createEnterpriseModule({ publicKey: key.publicKey }), createCompanyHermesModule(), createSitesModule()],
    });
    await fx.owner.ok('enterprise.license.set', {
      license: key.issue({ company: 'TC Flag', serverKeyId: fx.t.server.serverKeyId, issuedAt: fx.clock.now, expiresAt: fx.clock.now + 365 * DAY }),
    });
    // Ana has the role the panel will allow; Bia is a member without it.
    const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Gerente' });
    const ana = await fx.join({ nickname: 'Ana' });
    const bia = await fx.join({ nickname: 'Bia' });
    await fx.owner.ok('member.setRoles', { userId: ana.userId, roleIds: [role.id] });

    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const home = scratchHome();
    const hermes = runHermes(created.connectionToken, home);
    await hermes.until((l) => l.ready === true);
    // No role allowed yet: only the owner may talk to it.
    expect(await hermes.until((l) => l.event === 'hermes.config')).toMatchObject({ version: 0, allowed: [fx.owner.userId] });
    const first = await fx.owner.event<HermesState>('hermes.state', (s) => s.report !== null, 15_000);
    expect(first.report!.skills.map((s) => s.name)).toEqual(['hermes-agent', 'resumo']);

    const aiKey = `sk-test-ok-${randomBytes(12).toString('hex')}`; // fake, made now
    await fx.owner.ok('hermes.update', {
      keys: { deepseek: aiKey },
      models: { primary: { provider: 'deepseek', model: 'deepseek-flash' }, fallback: null },
      access: { roleIds: [role.id], channels: 'all' },
    });
    const v1 = await hermes.until((l) => l.event === 'hermes.config' && l.version === 1);
    expect(v1).toMatchObject({ env: { DEEPSEEK_API_KEY: true, OPENROUTER_API_KEY: false } });
    // permits(): the owner and the allowed role in, Bia (outside the panel's access rule) refused.
    expect(v1.allowed).toEqual([fx.owner.userId, ana.userId].sort());
    expect(v1.allowed).not.toContain(bia.userId);
    const applied = await fx.owner.event<HermesState>('hermes.state', (s) => s.report?.appliedVersion === 1 && s.report.status.keys.deepseek === 'ok', 15_000);
    expect(applied.report!.status.model).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(applied.report!.status.fallback).toBeNull();
    // The welcome's features reached the plugin: all five AI results, the keyless ones its own "missing".
    expect(applied.report!.status.keys).toEqual({ deepseek: 'ok', openrouter: 'missing', 'openai-api': 'missing', anthropic: 'missing', gemini: 'missing' });

    // v0.7.0: a key of the owner's own and a site reach the Hermes; the key only in its environment.
    const mine = `sk-test-mine-${randomBytes(12).toString('hex')}`; // fake, made now
    const saved = await fx.owner.ok<HermesState>('hermes.update', { apis: { MINHA_API_KEY: { name: 'Minha API', value: mine } } });
    expect(saved.apis).toContainEqual({ envVar: 'MINHA_API_KEY', name: 'Minha API', last4: mine.slice(-4) });
    expect(JSON.stringify(saved)).not.toContain(mine);
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 2)).toMatchObject({ env: { MINHA_API_KEY: true, DEEPSEEK_API_KEY: true }, sites: [] });
    // "Criar canal novo": the channel is named after the address, and the skill names it.
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null });
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 3)).toMatchObject({ sites: [site.domain], env: { MINHA_API_KEY: true } });
    const skill = readFileSync(join(home, 'skills', 'ghostlink', 'ghostlink-sites', 'SKILL.md'), 'utf8');
    expect(skill).toContain('| `Loja` | `loja.tcflag.com.br` | `#loja.tcflag.com.br` |');
    expect(skill).not.toContain(mine);
    expect(skill).not.toContain(aiKey);
    // The generated skill is in the Skills tab like any other.
    await fx.owner.event<HermesState>('hermes.state', (s) => s.report?.appliedVersion === 3 && s.report.skills.some((k) => k.name === 'ghostlink-sites'), 15_000);

    const config = readFileSync(join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('# TC Hermes (teste)');
    expect(config).toContain('default: deepseek-flash');
    expect(config).not.toContain('fallback_model');
    for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      expect(text).not.toContain(aiKey);
      expect(text).not.toContain(mine);
    }
    for (const app of [fx.owner, ana, bia]) {
      const events = JSON.stringify(app.events);
      expect(events).not.toContain(aiKey);
      expect(events).not.toContain(mine);
    }

    // Deleted in GhostLink, gone from the Hermes: the variable from its environment, the skill from its home.
    await fx.owner.ok('hermes.update', { apis: { MINHA_API_KEY: null } });
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 4)).toMatchObject({ env: { MINHA_API_KEY: false, DEEPSEEK_API_KEY: true } });
    await fx.owner.ok('site.delete', { id: site.id });
    expect(await hermes.until((l) => l.event === 'hermes.config' && l.version === 5)).toMatchObject({ sites: [] });
    expect(existsSync(join(home, 'skills', 'ghostlink', 'ghostlink-sites'))).toBe(false);

    const stock = applied.report!.memory.company.find((m) => m.text === 'O estoque fica em Guarulhos.')!;
    await fx.owner.ok('hermes.memory.delete', { target: 'company', id: stock.id });
    await fx.owner.event<HermesState>('hermes.state', (s) => s.report?.memory.company.length === 1, 15_000);
    expect(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8')).toBe('A TC Flag fabrica bandeiras.');
  });
});
