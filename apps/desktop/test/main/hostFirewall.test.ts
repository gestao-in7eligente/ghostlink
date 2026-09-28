import { describe, expect, it } from 'vitest';
import {
  FIREWALL_GROUP,
  HostFirewall,
  checkFirewall,
  elevatedCommand,
  evaluateFirewall,
  firewallFixScript,
  firewallPrograms,
  firewallQueryScript,
  fixFirewall,
  psQuote,
  type FirewallSnapshot,
  type PowerShellRunner,
} from '../../src/main/hostFirewall.js';

const EXE = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\ghostlink\\GhostLink.exe';
const ON = [
  { name: 'Domain', enabled: true },
  { name: 'Private', enabled: true },
  { name: 'Public', enabled: true },
];

function snap(patch: Partial<FirewallSnapshot>): FirewallSnapshot {
  return { active: ['Public'], profiles: ON, rules: [], ...patch };
}

function rule(action: 'Allow' | 'Block', profile: string, enabled = true, program = EXE) {
  return { program, action, profile, enabled };
}

describe('evaluateFirewall (spec §8.5)', () => {
  it.each<[string, Partial<FirewallSnapshot>, string]>([
    ['no rule at all', {}, 'missing'],
    ['an allow rule for any profile', { rules: [rule('Allow', 'Any')] }, 'allowed'],
    ['an allow rule for the active profile', { rules: [rule('Allow', 'Private, Public')] }, 'allowed'],
    ['an allow rule only for another profile', { rules: [rule('Allow', 'Private')] }, 'missing'],
    ['a disabled allow rule', { rules: [rule('Allow', 'Any', false)] }, 'missing'],
    ['a block rule (the prompt was cancelled)', { rules: [rule('Allow', 'Private'), rule('Block', 'Public')] }, 'blocked'],
    ['a block rule wins over an allow rule', { rules: [rule('Allow', 'Any'), rule('Block', 'Any')] }, 'blocked'],
    ['a block rule for another profile only', { rules: [rule('Allow', 'Public'), rule('Block', 'Private')] }, 'allowed'],
    ['the firewall is off on the active profile', { profiles: [{ name: 'Public', enabled: false }] }, 'off'],
    ['a domain network', { active: ['DomainAuthenticated'], rules: [rule('Allow', 'Domain')] }, 'allowed'],
    ['no active network at all', { active: [], rules: [rule('Allow', 'Private')] }, 'missing'],
  ])('%s → %s', (_label, patch, state) => {
    expect(evaluateFirewall(snap(patch), [EXE]).state).toBe(state);
  });

  it('every program needs its allow rule (GhostLink and LiveKit)', () => {
    const lk = 'C:\\app\\resources\\livekit\\livekit-server.exe';
    expect(evaluateFirewall(snap({ rules: [rule('Allow', 'Any')] }), [EXE, lk]).state).toBe('missing');
    expect(evaluateFirewall(snap({ rules: [rule('Allow', 'Any'), rule('Allow', 'Any', true, lk)] }), [EXE, lk]).state).toBe('allowed');
  });

  it('compares program paths without case (Windows)', () => {
    expect(evaluateFirewall(snap({ rules: [rule('Allow', 'Any', true, EXE.toUpperCase())] }), [EXE]).state).toBe('allowed');
  });
});

describe('PowerShell scripts', () => {
  it('psQuote makes a single-quoted literal and refuses control characters', () => {
    expect(psQuote("C:\\O'Brien\\x.exe")).toBe("'C:\\O''Brien\\x.exe'");
    expect(() => psQuote('C:\\a\nb')).toThrow();
    expect(() => psQuote('C:\\a\u0000b')).toThrow();
  });

  it('the query only reads (no Set/New/Remove cmdlets) and quotes every path', () => {
    const script = firewallQueryScript([EXE, "C:\\it's\\livekit-server.exe"]);
    expect(script).toContain(psQuote(EXE));
    expect(script).toContain("'C:\\it''s\\livekit-server.exe'");
    expect(script).not.toMatch(/\b(New|Set|Remove|Disable|Enable)-Net/);
    expect(script).toMatch(/ConvertTo-Json/);
  });

  it('the fix removes our old rules and inbound block rules, then allows TCP/UDP for each program', () => {
    const script = firewallFixScript({ programs: [EXE], tcpPorts: [7700, 7881], udpPorts: [7882] });
    expect(script).toContain(`Get-NetFirewallRule -Group '${FIREWALL_GROUP}'`);
    expect(script).toMatch(/Where-Object \{ \$_\.Direction -eq 'Inbound' -and \$_\.Action -eq 'Block' \} \| Remove-NetFirewallRule/);
    expect(script).toContain(`-Program ${psQuote(EXE)} -Protocol TCP -LocalPort 7700,7881`);
    expect(script).toContain(`-Program ${psQuote(EXE)} -Protocol UDP -LocalPort 7882`);
    expect(script).toContain(`-Group '${FIREWALL_GROUP}'`);
  });

  it.each([
    [{ programs: ['relative\\GhostLink.exe'], tcpPorts: [7700], udpPorts: [] }],
    [{ programs: [EXE], tcpPorts: [0], udpPorts: [] }],
    [{ programs: [EXE], tcpPorts: [70_000], udpPorts: [] }],
    [{ programs: [EXE], tcpPorts: [7700.5], udpPorts: [] }],
    [{ programs: [], tcpPorts: [7700], udpPorts: [] }],
  ])('the fix refuses bad input %j', (opts) => {
    expect(() => firewallFixScript(opts)).toThrow();
  });

  it('elevation runs the script through UAC as an encoded command (no quoting of the script itself)', () => {
    const args = elevatedCommand('Write-Output "hi"');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const outer = args[3]!;
    expect(outer).toMatch(/Start-Process .* -Verb RunAs -Wait -PassThru/);
    expect(outer).toMatch(/exit 1223/); // UAC cancelled
    const b64 = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe('Write-Output "hi"');
  });
});

describe('firewallPrograms', () => {
  it('lists the app executable, plus livekit-server.exe when it exists', () => {
    const exists = (p: string) => p.endsWith('livekit-server.exe');
    expect(firewallPrograms({ execPath: EXE, livekitCandidates: ['C:\\r\\livekit\\livekit-server.exe'], exists })).toEqual([EXE, 'C:\\r\\livekit\\livekit-server.exe']);
    expect(firewallPrograms({ execPath: EXE, livekitCandidates: ['C:\\r\\livekit\\livekit-server.exe'], exists: () => false })).toEqual([EXE]);
  });
});

describe('checkFirewall / fixFirewall', () => {
  const json = JSON.stringify({ active: ['Private'], profiles: ON, rules: [rule('Allow', 'Private')] });

  it('reads the snapshot through PowerShell', async () => {
    const calls: string[][] = [];
    const run: PowerShellRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: json };
    };
    expect(await checkFirewall({ programs: [EXE], run, platform: 'win32' })).toEqual({ state: 'allowed', activeProfiles: ['Private'] });
    expect(calls[0]!.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  it('is unsupported outside Windows and unknown when PowerShell fails or lies', async () => {
    expect((await checkFirewall({ programs: [EXE], run: async () => ({ code: 0, stdout: json }), platform: 'darwin' })).state).toBe('unsupported');
    expect((await checkFirewall({ programs: [EXE], run: async () => ({ code: 1, stdout: '' }), platform: 'win32' })).state).toBe('unknown');
    expect((await checkFirewall({ programs: [EXE], run: async () => ({ code: 0, stdout: '{"active":5}' }), platform: 'win32' })).state).toBe('unknown');
    expect((await checkFirewall({ programs: [EXE], run: () => Promise.reject(new Error('ENOENT')), platform: 'win32' })).state).toBe('unknown');
  });

  it.each([
    [0, 'done'],
    [1223, 'cancelled'],
    [1, 'failed'],
  ] as const)('the fix maps exit code %i to %s', async (code, result) => {
    const run: PowerShellRunner = async () => ({ code, stdout: '' });
    expect(await fixFirewall({ programs: [EXE], tcpPorts: [7700], udpPorts: [7882], run, platform: 'win32' })).toBe(result);
  });

  it('HostFirewall caches the check for a while and re-checks after a fix', async () => {
    let now = 0;
    let checks = 0;
    const fw = new HostFirewall({
      programs: () => [EXE],
      ports: () => ({ tcpPorts: [7700, 7881], udpPorts: [7882] }),
      platform: 'win32',
      now: () => now,
      run: async (args) => {
        if (args[3]!.includes('Start-Process')) return { code: 0, stdout: '' };
        checks++;
        return { code: 0, stdout: json };
      },
    });
    await fw.status();
    await fw.status();
    expect(checks).toBe(1);
    now += 60_000;
    await fw.status();
    expect(checks).toBe(2);
    expect(await fw.fix()).toEqual({ result: 'done', status: { state: 'allowed', activeProfiles: ['Private'] } });
    expect(checks).toBe(3);
  });
});
