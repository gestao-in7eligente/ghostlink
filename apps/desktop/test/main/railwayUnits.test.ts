import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPlan } from '../../src/main/railway/account.js';
import { RAILWAY_IMAGE_REPOSITORY, railwayImage } from '../../src/main/railway/image.js';
import { normalizeFingerprint, parseServerStart, redactLogLine, stripAnsi } from '../../src/main/railway/logs.js';
import { projectName, serverVariables } from '../../src/main/railway/provisioner.js';
import { RAILWAY_FILE, RailwayStore } from '../../src/main/railway/store.js';
import { RAILWAY_TOKEN_FILE, RailwayTokenStore, normalizeToken } from '../../src/main/railway/token.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const FP = 'ABCDEFGH IJKLMNOP QRSTUVWX YZ234567';
const CODE = '3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718';
const ESC = String.fromCharCode(0x1b);

describe('parseServerStart (apps/server/src/cli.ts start lines)', () => {
  it('reads the fingerprint and the setup code', () => {
    expect(
      parseServerStart([
        { message: 'GhostLink server 0.2.0' },
        { message: 'Listening on 0.0.0.0:7700' },
        { message: `Fingerprint: ${FP}` },
        { message: `Setup code (use it once to become the owner): ${CODE}` },
      ]),
    ).toEqual({ fingerprint: FP, setupCode: CODE });
  });

  it('copes with timestamps, ANSI colours, several lines per message and odd case', () => {
    const lines = [
      { message: `${ESC}[32m2026-09-29T12:00:00.000Z${ESC}[0m info Fingerprint: ${FP.toLowerCase()}\r\n` },
      { message: `[ghostlink] boot\n${ESC}[1mSetup code (use it once to become the owner):${ESC}[22m ${CODE.toUpperCase()}` },
    ];
    expect(parseServerStart(lines)).toEqual({ fingerprint: FP, setupCode: CODE });
  });

  it('takes the latest lines after a restart, by timestamp when Railway gives one', () => {
    const later = 'ZZZZZZZZ YYYYYYYY XXXXXXXX WWWWWWWW';
    const code2 = 'ffffffff-eeeeeeee-dddddddd-cccccccc';
    expect(
      parseServerStart([
        { timestamp: '2026-09-29T12:05:00.000000000Z', message: `Fingerprint: ${later}` },
        { timestamp: '2026-09-29T12:05:00.100000000Z', message: `Setup code (use it once to become the owner): ${code2}` },
        { timestamp: '2026-09-29T12:00:00.000000000Z', message: `Fingerprint: ${FP}` },
        { timestamp: '2026-09-29T12:00:00.100000000Z', message: `Setup code (use it once to become the owner): ${CODE}` },
      ]),
    ).toEqual({ fingerprint: later, setupCode: code2 });
    expect(parseServerStart([{ message: `Fingerprint: ${FP}` }, { message: `Fingerprint: ${later}` }]).fingerprint).toBe(later);
  });

  it('finds nothing in unrelated or truncated lines', () => {
    expect(parseServerStart([])).toEqual({ fingerprint: null, setupCode: null });
    expect(
      parseServerStart([
        { message: 'Fingerprint: ABCDEFGH IJKLMNOP' },
        { message: 'Setup code (use it once to become the owner): 3f9a2b1c-7d4e' },
        { message: `Public addresses: roundhouse.proxy.rlwy.net:15140 ${CODE}` },
      ]),
    ).toEqual({ fingerprint: null, setupCode: null });
  });

  it('compares fingerprints across spacing and case', () => {
    expect(normalizeFingerprint(' abcdefgh  IJKLMNOP\tqrstuvwx yz234567 ')).toBe(normalizeFingerprint(FP));
  });

  it('never lets a setup code into main.log', () => {
    expect(redactLogLine(`${ESC}[31mSetup code (use it once to become the owner): ${CODE}${ESC}[0m`)).toBe('Setup code (use it once to become the owner): [redacted]');
    expect(stripAnsi(`${ESC}[1;31mboom${ESC}[0m`)).toBe('boom');
  });
});

describe('railwayImage', () => {
  it('is the GHCR image tagged with the app version', () => {
    expect(railwayImage({ version: '0.2.0', packaged: true, env: {} })).toBe('ghcr.io/gestao-in7eligente/ghostlink-server:0.2.0');
    expect(RAILWAY_IMAGE_REPOSITORY).toBe('ghcr.io/gestao-in7eligente/ghostlink-server');
  });

  it('takes GHOSTLINK_RAILWAY_IMAGE in development only', () => {
    const env = { GHOSTLINK_RAILWAY_IMAGE: ' ghcr.io/me/test:dev ' };
    expect(railwayImage({ version: '0.2.0', packaged: false, env })).toBe('ghcr.io/me/test:dev');
    expect(railwayImage({ version: '0.2.0', packaged: true, env })).toBe('ghcr.io/gestao-in7eligente/ghostlink-server:0.2.0');
    expect(railwayImage({ version: '0.2.0', packaged: false, env: { GHOSTLINK_RAILWAY_IMAGE: '  ' } })).toBe('ghcr.io/gestao-in7eligente/ghostlink-server:0.2.0');
  });
});

describe('provisioning helpers', () => {
  it('names the project ghostlink-<slug>', () => {
    expect(projectName('Casa do Zé')).toBe('ghostlink-casa-do-ze');
    expect(projectName('  Café & Código!! ')).toBe('ghostlink-cafe-codigo');
    expect(projectName('👻👻')).toBe('ghostlink-server');
    expect(projectName('a'.repeat(100))).toBe(`ghostlink-${'a'.repeat(40)}`);
  });

  it('sets exactly the variables the image reads', () => {
    expect(serverVariables('Casa do Zé')).toEqual({
      GHOSTLINK_NAME: 'Casa do Zé',
      GHOSTLINK_VOICE: '1',
      GHOSTLINK_PORT: '7700',
      PORT: '7700',
      GHOSTLINK_DATA: '/data',
    });
  });

  it('maps Railway plans, trials first', () => {
    expect(toPlan('FREE')).toBe('FREE');
    expect(toPlan('HOBBY')).toBe('HOBBY');
    expect(toPlan('PRO')).toBe('PRO');
    expect(toPlan('HOBBY', true)).toBe('TRIAL');
    expect(toPlan(null)).toBe('UNKNOWN');
    expect(toPlan(undefined)).toBe('UNKNOWN');
  });
});

describe('RailwayTokenStore', () => {
  const dir = useTempDir();
  const TOKEN = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

  it('trims a pasted token and refuses what cannot be one', () => {
    expect(normalizeToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeToken('   ')).toBeNull();
    expect(normalizeToken('two words')).toBeNull();
    expect(normalizeToken('line\nbreak')).toBeNull();
    expect(normalizeToken('tokén')).toBeNull();
    expect(normalizeToken('x'.repeat(513))).toBeNull();
    expect(normalizeToken('x'.repeat(512))).toBe('x'.repeat(512));
  });

  it('stores the token encrypted (0600) and forgets it', () => {
    const store = new RailwayTokenStore(dir.path, new FakeSafeStorage());
    expect(store.read()).toBeNull();
    store.save(TOKEN);
    const file = join(dir.path, RAILWAY_TOKEN_FILE);
    expect(readFileSync(file).includes(Buffer.from(TOKEN))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new RailwayTokenStore(dir.path, new FakeSafeStorage()).read()).toBe(TOKEN);
    store.clear();
    expect(existsSync(file)).toBe(false);
    expect(store.read()).toBeNull();
  });

  it('refuses to store without encryption, and reads nothing it cannot decrypt', () => {
    const safe = new FakeSafeStorage();
    safe.available = false;
    expect(() => new RailwayTokenStore(dir.path, safe).save(TOKEN)).toThrow(expect.objectContaining({ code: 'ENCRYPTION_UNAVAILABLE' }));
    expect(existsSync(join(dir.path, RAILWAY_TOKEN_FILE))).toBe(false);
    const ok = new FakeSafeStorage();
    new RailwayTokenStore(dir.path, ok).save(TOKEN);
    ok.failDecrypt = true;
    expect(new RailwayTokenStore(dir.path, ok).read()).toBeNull();
  });
});

describe('RailwayStore: outdatedSince (servers follow the app, spec 2026-10-01 §3)', () => {
  const dir = useTempDir();
  const KEY = 'A'.repeat(43);
  const OTHER = 'B'.repeat(43);
  const record = (serverKeyId: string) => ({
    projectId: 'proj-1',
    environmentId: 'env-1',
    serviceId: 'svc-1',
    volumeId: 'vol-1',
    address: 'roundhouse.proxy.rlwy.net:15140',
    serverKeyId,
    region: 'us-east4-eqdc4a',
    createdAt: 1_000,
  });

  it('loads a v0.2.0 file (no outdatedSince) as it is', () => {
    writeFileSync(join(dir.path, RAILWAY_FILE), JSON.stringify({ version: 1, pending: null, managed: [record(KEY)] }));
    expect(RailwayStore.load(dir.path).managed).toEqual([record(KEY)]);
    expect(readdirSync(dir.path).some((f) => f.includes('.corrupt-'))).toBe(false);
  });

  it('records and clears it for one server only, and keeps it on disk', () => {
    writeFileSync(join(dir.path, RAILWAY_FILE), JSON.stringify({ version: 1, pending: null, managed: [record(KEY), record(OTHER)] }));
    const store = RailwayStore.load(dir.path);
    expect(store.setOutdatedSince(KEY, 5_000)).toBe(true);
    expect(RailwayStore.load(dir.path).managed).toEqual([{ ...record(KEY), outdatedSince: 5_000 }, record(OTHER)]);
    expect(store.setOutdatedSince(KEY, null)).toBe(true);
    const cleared = RailwayStore.load(dir.path).managed;
    expect(cleared).toEqual([record(KEY), record(OTHER)]);
    expect('outdatedSince' in cleared[0]!).toBe(false);
  });

  it('does nothing for a server it does not manage', () => {
    const store = RailwayStore.load(dir.path);
    expect(store.setOutdatedSince(KEY, 5_000)).toBe(false);
    expect(existsSync(join(dir.path, RAILWAY_FILE))).toBe(false);
  });
});
