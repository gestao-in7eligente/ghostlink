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
  runPowerShell,
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

  // PowerShell ends a single-quoted string at any of these, not only at the ASCII quote.
  const QUOTES = ["'", '\u2018', '\u2019', '\u201A', '\u201B'];

  it.each(QUOTES.map((q) => [`U+${q.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, q]))(
    'psQuote doubles %s, a single quote to PowerShell',
    (_name, q) => {
      const path = `C:\\Users\\Joana D${q}Arc\\AppData\\Local\\Programs\\ghostlink\\GhostLink.exe`;
      expect(psQuote(path)).toBe(`'C:\\Users\\Joana D${q}${q}Arc\\AppData\\Local\\Programs\\ghostlink\\GhostLink.exe'`);
    },
  );

  it('psQuote output never ends the literal early, whatever mix of quotes the path has', () => {
    // PowerShell's rule: inside '…', a quote followed by another quote is one literal
    // quote (the second one); a lone quote ends the string.
    const isQuote = (c: string | undefined) => c !== undefined && QUOTES.includes(c);
    const parse = (literal: string): { value: string; rest: string } => {
      expect(isQuote(literal[0])).toBe(true);
      let value = '';
      for (let i = 1; i < literal.length; i++) {
        const c = literal[i]!;
        if (!isQuote(c)) value += c;
        else if (isQuote(literal[i + 1])) value += literal[++i]!;
        else return { value, rest: literal.slice(i + 1) };
      }
      throw new Error('unterminated');
    };
    const path = `C:\\${QUOTES.join('x')}\\${QUOTES.join('')}\\GhostLink.exe`;
    expect(parse(`${psQuote(path)}; Remove-Item x`)).toEqual({ value: path, rest: '; Remove-Item x' });
  });

  it.runIf(process.platform === 'win32')('psQuote literals round-trip through the real Windows PowerShell', async () => {
    const path = `C:\\Users\\Joana D\u2019Arc\\${QUOTES.join('')}\\GhostLink.exe`;
    const script = `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${psQuote(path)}))`;
    const { code, stdout } = await runPowerShell(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    expect(code).toBe(0);
    expect(Buffer.from(stdout.trim(), 'base64').toString('utf8')).toBe(path);
    // A cold Windows PowerShell on a CI runner can take over 20 s to start.
  }, 90_000);

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
