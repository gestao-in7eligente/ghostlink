// The one-time switch to a same-version build a server offers (plan 2026-10-05-v083-troca-automatica, Task 5):
// fetch latest.yml from the channel, confirm the offered version equals the running one, download the installer,
// verify it against the pinned release key, and only then run it. Every native effect is injected, so the logic is
// fully testable. Nothing here names an edition; the channel path is never leaked into a log.
import { describe, expect, it, vi } from 'vitest';
import { CrossGrade, type CrossGradeDeps } from '../../src/main/updater/crossGrade.js';
import type { ReleaseFileLocation } from '../../src/main/updaterSignature.js';

const CODE = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY';
const CHANNEL = `https://host.example/updates/${CODE}/`;
const VERSION = '0.8.3';
const INSTALLER = 'GhostLink-Alt-Setup-0.8.3.exe';
const enc = (s: string) => new TextEncoder().encode(s);

/** electron-builder's latest.yml, with the two fields the reader uses (version and the top-level installer path). */
const latestYml = (version: string, path: string): string =>
  `version: ${version}\nfiles:\n  - url: ${path}\n    sha512: 3q2+7w==\n    size: 123\npath: ${path}\nsha512: 3q2+7w==\nreleaseDate: '2026-10-05T00:00:00.000Z'\n`;

function make(overrides: Partial<CrossGradeDeps> = {}) {
  const logs: string[] = [];
  const run = vi.fn(async () => {});
  const verify = vi.fn(async (_path: string, _version: string, _location: ReleaseFileLocation) => null as string | null);
  const fetchInstaller = vi.fn(async (_url: string, _max: number, dest: string) => dest);
  const fetchReleaseFile = vi.fn(async (_url: string, _max: number) => enc(latestYml(VERSION, INSTALLER)));
  const deps: CrossGradeDeps = {
    enabled: true,
    currentVersion: VERSION,
    autoCheck: () => true,
    updateInFlight: () => false,
    channel: () => ({ url: CHANNEL }),
    tempDir: '/tmp/ghostlink',
    fetchReleaseFile,
    fetchInstaller,
    verify,
    run,
    log: (m) => logs.push(m),
    now: () => 1_000,
    ...overrides,
  };
  return { cg: new CrossGrade(deps), logs, run, verify, fetchInstaller, fetchReleaseFile };
}

describe('CrossGrade', () => {
  it('downloads, verifies, then runs a correctly advertised same-version build', async () => {
    const { cg, run, verify, fetchInstaller, fetchReleaseFile } = make();
    await cg.maybeCrossGrade();
    expect(fetchReleaseFile).toHaveBeenCalledWith(`${CHANNEL}latest.yml`, expect.any(Number));
    expect(fetchInstaller).toHaveBeenCalledWith(`${CHANNEL}${INSTALLER}`, expect.any(Number), expect.stringContaining(INSTALLER));
    expect(verify).toHaveBeenCalledTimes(1);
    const [verifiedPath, version, location] = verify.mock.calls[0]!;
    expect(version).toBe(VERSION);
    expect(location.installerName(VERSION)).toBe(INSTALLER);
    expect(location.fileUrl(VERSION, 'checksums-sha256.txt')).toBe(`${CHANNEL}checksums-sha256.txt`);
    expect(() => location.fileUrl(VERSION, '../latest.yml')).toThrow();
    // Run with exactly the verified path, and only after verification.
    expect(run).toHaveBeenCalledWith(verifiedPath);
    expect(verify.mock.invocationCallOrder[0]!).toBeLessThan(run.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['newer', '0.8.4'],
    ['older', '0.8.2'],
  ])('does nothing when the offered version is %s than the running one', async (_label, version) => {
    const { cg, run, fetchInstaller } = make({ fetchReleaseFile: vi.fn(async () => enc(latestYml(version, INSTALLER))) });
    await cg.maybeCrossGrade();
    expect(fetchInstaller).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses after verification fails: the installer is downloaded and verified, but never run', async () => {
    const verify = vi.fn(async () => 'Ed25519 signature does not match the release key');
    const { cg, run, fetchInstaller } = make({ verify });
    await cg.maybeCrossGrade();
    expect(fetchInstaller).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an installer name that is not a plain file name, downloading nothing', async () => {
    for (const bad of ['../evil.exe', 'a/b.exe', '']) {
      const { cg, run, fetchInstaller } = make({ fetchReleaseFile: vi.fn(async () => enc(latestYml(VERSION, bad))) });
      await cg.maybeCrossGrade();
      expect(fetchInstaller).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('does nothing when latest.yml has no version or cannot be read', async () => {
    const noVersion = make({ fetchReleaseFile: vi.fn(async () => enc(`files:\n  - url: ${INSTALLER}\n`)) });
    await noVersion.cg.maybeCrossGrade();
    expect(noVersion.fetchInstaller).not.toHaveBeenCalled();

    const broken = make({ fetchReleaseFile: vi.fn(async () => { throw new Error('HTTP 404'); }) });
    await broken.cg.maybeCrossGrade();
    expect(broken.fetchInstaller).not.toHaveBeenCalled();
    expect(broken.run).not.toHaveBeenCalled();
  });

  it('runs at most once per session, even across repeated calls', async () => {
    const { cg, run } = make();
    await cg.maybeCrossGrade();
    await cg.maybeCrossGrade();
    await cg.maybeCrossGrade();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stands aside when disabled, when updates are off, with no channel, or while a normal update runs', async () => {
    const guards: Array<Partial<CrossGradeDeps>> = [
      { enabled: false },
      { autoCheck: () => false },
      { channel: () => null },
      { updateInFlight: () => true },
    ];
    for (const g of guards) {
      const { cg, run, fetchReleaseFile } = make(g);
      await cg.maybeCrossGrade();
      expect(fetchReleaseFile).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('never leaks the channel path into a log, whatever fails', async () => {
    const cases = [
      make({ fetchReleaseFile: vi.fn(async () => { throw new Error(`HttpError: 404 GET ${CHANNEL}latest.yml?x=1`); }) }),
      make({ verify: vi.fn(async () => `refused at ${CHANNEL}${INSTALLER}`) }),
      make({ fetchInstaller: vi.fn(async () => { throw new Error(`stream failed for ${CHANNEL}${INSTALLER}`); }) }),
    ];
    for (const c of cases) {
      await c.cg.maybeCrossGrade();
      const text = c.logs.join('\n');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(CHANNEL);
      expect(text).toContain('[redacted]');
    }
  });
});
