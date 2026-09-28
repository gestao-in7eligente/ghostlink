// Windows Firewall for Host mode (spec §8.5): detect whether inbound connections to
// GhostLink (and livekit-server.exe) are allowed, and "Corrigir firewall" through UAC.
//
// The fix uses the NetSecurity cmdlets rather than `netsh advfirewall`: they add the
// same inbound program rules, but take the program path as a typed argument (no
// command-line quoting), and they can also remove the inbound *block* rules Windows
// created when someone cancelled its "Permitir acesso" prompt (a block rule would
// win over any allow rule). Paths are embedded as single-quoted PowerShell literals
// and the whole script travels as -EncodedCommand.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FirewallFixResult, FirewallState, FirewallStatus } from '../shared/hostTypes.js';

export const FIREWALL_GROUP = 'GhostLink';
const CHECK_TTL_MS = 30_000;
const ERROR_CANCELLED = 1223; // Windows: the user said no to UAC

export interface FirewallRuleInfo {
  program: string;
  enabled: boolean;
  action: string;
  /** "Any", or a list such as "Private, Public". */
  profile: string;
}

/** What the read-only PowerShell query returns. */
export interface FirewallSnapshot {
  /** Network categories of the connected networks: Public, Private, DomainAuthenticated. */
  active: string[];
  profiles: Array<{ name: string; enabled: boolean }>;
  /** Inbound rules for the programs. */
  rules: FirewallRuleInfo[];
}

export type PowerShellRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** A single-quoted PowerShell string literal. Control characters are refused, never escaped. */
export function psQuote(s: string): string {
  if ([...s].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f')) throw new Error('refusing a control character in a PowerShell literal');
  return `'${s.replace(/'/g, "''")}'`;
}

function profileOf(category: string): string {
  return category === 'DomainAuthenticated' ? 'Domain' : category;
}

function covers(ruleProfile: string, profile: string): boolean {
  return ruleProfile === 'Any' || ruleProfile.split(',').map((p) => p.trim()).includes(profile);
}

/** The state for these programs on the active networks. */
export function evaluateFirewall(snapshot: FirewallSnapshot, programs: readonly string[]): FirewallStatus {
  const active = [...new Set(snapshot.active.map(profileOf))];
  const status = (state: FirewallState): FirewallStatus => ({ state, activeProfiles: [...new Set(snapshot.active)] });
  // With no connected network Windows applies the Public profile to new connections.
  const considered = active.length > 0 ? active : ['Public'];
  const guarded = considered.filter((p) => snapshot.profiles.find((x) => x.name === p)?.enabled !== false);
  if (guarded.length === 0) return status('off');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let allAllowed = true;
  for (const program of programs) {
    const rules = snapshot.rules.filter((r) => r.enabled && same(r.program, program));
    if (rules.some((r) => r.action === 'Block' && guarded.some((p) => covers(r.profile, p)))) return status('blocked');
    if (!guarded.every((p) => rules.some((r) => r.action === 'Allow' && covers(r.profile, p)))) allAllowed = false;
  }
  return status(allAllowed ? 'allowed' : 'missing');
}

/** Read-only: active networks, firewall profiles and the inbound rules of each program, as JSON. */
export function firewallQueryScript(programs: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$programs = @(${programs.map(psQuote).join(', ')})`,
    '$active = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $_.NetworkCategory.ToString() })',
    "$profiles = @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name = $_.Name.ToString(); enabled = ($_.Enabled.ToString() -eq 'True') } })",
    '$rules = @(foreach ($p in $programs) { Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |',
    "  Where-Object { $_.Direction.ToString() -eq 'Inbound' } | ForEach-Object { [pscustomobject]@{ program = $p; enabled = ($_.Enabled.ToString() -eq 'True'); action = $_.Action.ToString(); profile = $_.Profile.ToString() } } })",
    '[pscustomobject]@{ active = $active; profiles = $profiles; rules = $rules } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

function checkPorts(ports: readonly number[]): string {
  for (const p of ports) if (!Number.isInteger(p) || p < 1 || p > 65_535) throw new Error(`invalid port ${p}`);
  return ports.join(',');
}

/** The elevated part of "Corrigir firewall". */
export function firewallFixScript(opts: { programs: readonly string[]; tcpPorts: readonly number[]; udpPorts: readonly number[] }): string {
  if (opts.programs.length === 0) throw new Error('no program to allow');
  for (const p of opts.programs) if (!isAbsolute(p)) throw new Error('program paths must be absolute');
  const tcp = checkPorts(opts.tcpPorts);
  const udp = checkPorts(opts.udpPorts);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Get-NetFirewallRule -Group '${FIREWALL_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ];
  for (const program of opts.programs) {
    const p = psQuote(program);
    const name = program.split(/[\\/]/).pop() ?? 'GhostLink';
    lines.push(
      `  Get-NetFirewallApplicationFilter -Program ${p} -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule`,
    );
    if (tcp) lines.push(`  New-NetFirewallRule -DisplayName ${psQuote(`GhostLink (${name}, TCP)`)} -Group '${FIREWALL_GROUP}' -Direction Inbound -Action Allow -Profile Any -Program ${p} -Protocol TCP -LocalPort ${tcp} | Out-Null`);
    if (udp) lines.push(`  New-NetFirewallRule -DisplayName ${psQuote(`GhostLink (${name}, UDP)`)} -Group '${FIREWALL_GROUP}' -Direction Inbound -Action Allow -Profile Any -Program ${p} -Protocol UDP -LocalPort ${udp} | Out-Null`);
  }
  lines.push('  exit 0', '} catch { exit 1 }');
  return lines.join('\n');
}

/** powershell.exe arguments that run `script` elevated (UAC) and exit with its code, or 1223 when UAC was refused. */
export function elevatedCommand(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const outer =
    "try { $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit ${ERROR_CANCELLED} }`;
  return ['-NoProfile', '-NonInteractive', '-Command', outer];
}

/** Windows PowerShell by absolute path (no PATH lookup). */
export const runPowerShell: PowerShellRunner = (args) =>
  new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(exe, args, { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && typeof (error as { code?: unknown }).code !== 'number') return reject(error);
      resolve({ code: error ? ((error as { code: number }).code) : 0, stdout: String(stdout) });
    });
  });

function isSnapshot(v: unknown): v is FirewallSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const arr = (x: unknown) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);
  // ConvertTo-Json turns one-element arrays into objects: normalize first.
  s.active = arr(s.active);
  s.profiles = arr(s.profiles);
  s.rules = arr(s.rules);
  return (
    (s.active as unknown[]).every((a) => typeof a === 'string') &&
    (s.profiles as unknown[]).every((p) => typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string') &&
    (s.rules as unknown[]).every((r) => typeof r === 'object' && r !== null && typeof (r as { program?: unknown }).program === 'string')
  );
}

export async function checkFirewall(opts: { programs: readonly string[]; run?: PowerShellRunner; platform?: NodeJS.Platform }): Promise<FirewallStatus> {
  if ((opts.platform ?? process.platform) !== 'win32') return { state: 'unsupported', activeProfiles: [] };
  try {
    const { code, stdout } = await (opts.run ?? runPowerShell)(['-NoProfile', '-NonInteractive', '-Command', firewallQueryScript(opts.programs)]);
    if (code !== 0) return { state: 'unknown', activeProfiles: [] };
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isSnapshot(parsed)) return { state: 'unknown', activeProfiles: [] };
    return evaluateFirewall(parsed, opts.programs);
  } catch {
    return { state: 'unknown', activeProfiles: [] };
  }
}

export async function fixFirewall(opts: {
  programs: readonly string[];
  tcpPorts: readonly number[];
  udpPorts: readonly number[];
  run?: PowerShellRunner;
  platform?: NodeJS.Platform;
}): Promise<FirewallFixResult> {
  if ((opts.platform ?? process.platform) !== 'win32') return 'unsupported';
  const script = firewallFixScript(opts);
  try {
    const { code } = await (opts.run ?? runPowerShell)(elevatedCommand(script));
    return code === 0 ? 'done' : code === ERROR_CANCELLED ? 'cancelled' : 'failed';
  } catch {
    return 'failed';
  }
}

/** GhostLink.exe (the utility process is the same executable) and livekit-server.exe when present. */
export function firewallPrograms(opts: { execPath: string; livekitCandidates: readonly string[]; exists?: (p: string) => boolean }): string[] {
  const exists = opts.exists ?? existsSync;
  const livekit = opts.livekitCandidates.find((p) => exists(p));
  return livekit ? [opts.execPath, livekit] : [opts.execPath];
}

export interface HostFirewallOptions {
  programs: () => string[];
  ports: () => { tcpPorts: number[]; udpPorts: number[] };
  run?: PowerShellRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** The Host panel's firewall state, cached for 30 s (the query takes a second or two). */
export class HostFirewall {
  readonly #o: HostFirewallOptions;
  #cached: { at: number; status: FirewallStatus } | null = null;

  constructor(opts: HostFirewallOptions) {
    this.#o = opts;
  }

  async status(force = false): Promise<FirewallStatus> {
    const now = (this.#o.now ?? Date.now)();
    if (!force && this.#cached && now - this.#cached.at < CHECK_TTL_MS) return this.#cached.status;
    const status = await checkFirewall({ programs: this.#o.programs(), run: this.#o.run, platform: this.#o.platform });
    this.#cached = { at: now, status };
    return status;
  }

  async fix(): Promise<{ result: FirewallFixResult; status: FirewallStatus }> {
    const result = await fixFirewall({ programs: this.#o.programs(), ...this.#o.ports(), run: this.#o.run, platform: this.#o.platform });
    return { result, status: await this.status(true) };
  }
}
