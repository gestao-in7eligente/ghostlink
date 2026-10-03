import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, loadMigrations } from '../src/db/database.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function open(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-m011-'));
  dirs.push(dir);
  return new Db(join(dir, 'ghostlink.db'));
}

describe('011_apis_and_sites.sql', () => {
  it("moves v0.6's two keys to company_hermes_keys and empties the old columns", () => {
    const db = open();
    const all = loadMigrations();
    db.migrate(all.slice(0, 10)); // a 0.6.3-shaped database
    // Made now, never a real key.
    const deepseek = `fake-deepseek-${randomBytes(8).toString('hex')}`;
    const openrouter = `fake-openrouter-${randomBytes(8).toString('hex')}`;
    db.run(
      "INSERT INTO company_hermes (id, deepseek_key, openrouter_key, settings, version) VALUES (1, ?, ?, '{\"kept\":true}', 7)",
      deepseek,
      openrouter,
    );
    db.migrate(all);
    expect(db.all('SELECT env_var, name, value FROM company_hermes_keys ORDER BY env_var')).toEqual([
      { env_var: 'DEEPSEEK_API_KEY', name: 'DeepSeek', value: deepseek },
      { env_var: 'OPENROUTER_API_KEY', name: 'OpenRouter', value: openrouter },
    ]);
    expect(db.get('SELECT deepseek_key, openrouter_key, settings, version FROM company_hermes WHERE id = 1')).toEqual({
      deepseek_key: null,
      openrouter_key: null,
      settings: '{"kept":true}',
      version: 7,
    });
    db.close();
  });

  it('moves only the key that is set, and nothing when there is none', () => {
    const one = open();
    const all = loadMigrations();
    one.migrate(all.slice(0, 10));
    const openrouter = `fake-openrouter-${randomBytes(8).toString('hex')}`;
    one.run('INSERT INTO company_hermes (id, openrouter_key) VALUES (1, ?)', openrouter);
    one.migrate(all);
    expect(one.all('SELECT env_var, value FROM company_hermes_keys')).toEqual([{ env_var: 'OPENROUTER_API_KEY', value: openrouter }]);
    one.close();

    const none = open();
    none.migrate(all.slice(0, 10));
    none.run('INSERT INTO company_hermes (id) VALUES (1)');
    none.migrate(all);
    expect(none.all('SELECT env_var FROM company_hermes_keys')).toEqual([]);
    none.close();
  });
});

describe('company_hermes_keys.env_var', () => {
  it.each(['lower_key', 'WITH-DASH_KEY', 'WITH SPACE', '1STARTS_KEY', '_STARTS_KEY', 'AB', 'MY_KEY\n'])('refuses %j', (envVar) => {
    const db = open();
    db.migrate(loadMigrations());
    expect(() => db.run('INSERT INTO company_hermes_keys (env_var, name, value) VALUES (?, ?, ?)', envVar, 'n', 'fake-value-0001')).toThrow();
    db.close();
  });

  it('takes a plain variable name', () => {
    const db = open();
    db.migrate(loadMigrations());
    db.run('INSERT INTO company_hermes_keys (env_var, name, value) VALUES (?, ?, ?)', 'MY_API_KEY', 'n', 'fake-value-0001');
    db.close();
  });
});
