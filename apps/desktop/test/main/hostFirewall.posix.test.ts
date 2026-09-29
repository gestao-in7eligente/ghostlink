// The firewall code handles Windows paths only (GhostLink.exe, livekit-server.exe,
// %SystemRoot%), so it must never go through the host platform's `path`: CI also runs on
// Linux and macOS, where `C:\…` is not absolute and `join` uses "/". Here `node:path` is
// the POSIX implementation (as on those runners) and the Windows paths must still work.
import type * as NodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async () => {
  const { posix } = await vi.importActual<typeof NodePath>('node:path');
  return { ...posix, default: posix };
});

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile, default: { execFile } }));

const { HostFirewall, firewallFixScript, fixFirewall, psQuote, runPowerShell } = await import('../../src/main/hostFirewall.js');

const EXE = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\ghostlink\\GhostLink.exe';
const LIVEKIT = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\ghostlink\\resources\\livekit\\livekit-server.exe';

describe('hostFirewall with a POSIX node:path', () => {
  it('the host path module really is POSIX in this file', async () => {
    const path = await import('node:path');
    expect(path.isAbsolute(EXE)).toBe(false);
    expect(path.sep).toBe('/');
  });

  it('accepts absolute Windows program paths (drive and UNC) and names the rules after the file', () => {
    const script = firewallFixScript({ programs: [EXE, LIVEKIT, '\\\\nas\\apps\\GhostLink.exe'], tcpPorts: [7700], udpPorts: [7882] });
    expect(script).toContain(`-Program ${psQuote(EXE)} -Protocol TCP -LocalPort 7700`);
    expect(script).toContain(`-DisplayName ${psQuote('GhostLink (livekit-server.exe, UDP)')}`);
    expect(script).toContain(`-Program ${psQuote('\\\\nas\\apps\\GhostLink.exe')} -Protocol UDP -LocalPort 7882`);
  });

  it.each(['GhostLink.exe', 'programs\\GhostLink.exe', 'C:GhostLink.exe', './GhostLink.exe'])('still refuses the relative path %s', (program) => {
    expect(() => firewallFixScript({ programs: [program], tcpPorts: [7700], udpPorts: [] })).toThrow(/absolute/);
  });

  it('fixFirewall and HostFirewall.fix reach PowerShell', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ active: ['Private'], profiles: [{ name: 'Private', enabled: true }], rules: [] }) }));
    expect(await fixFirewall({ programs: [EXE], tcpPorts: [7700], udpPorts: [7882], run, platform: 'win32' })).toBe('done');
    const fw = new HostFirewall({ programs: () => [EXE], ports: () => ({ tcpPorts: [7700], udpPorts: [7882] }), run, platform: 'win32' });
    expect((await fw.fix()).result).toBe('done');
  });

  it('runs powershell.exe from a Windows path under %SystemRoot%', async () => {
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = 'D:\\Win';
    execFile.mockImplementationOnce((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'ok'));
    try {
      await runPowerShell(['-NoProfile']);
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
    expect(execFile.mock.calls[0]![0]).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});
