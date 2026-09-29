import { LIMITS, normalizeInviteCode, parseJoinInput, type ParsedJoinInput } from '@ghostlink/shared';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { JoinConnectRequest, SavedServer } from '../../shared/ipcTypes.js';

/** Where the join goes: from an invite, or from a bare address confirmed by fingerprint (spec §3.3). */
export interface JoinTarget {
  addresses: string[];
  serverKeyId: string;
  inviteCode?: string;
  name?: string;
}

export type JoinStep = 'input' | 'probing' | 'confirm' | 'details' | 'connecting' | 'done';

export interface JoinState {
  step: JoinStep;
  input: string;
  /** The bare address being probed (TOFU). */
  probeAddress: string | null;
  target: JoinTarget | null;
  /** 'invite' shows the invite summary; 'tofu' asks the user to compare the fingerprint. */
  source: 'invite' | 'tofu' | null;
  fingerprint: string | null;
  /** A saved server that used another key at this address (possible impersonation). */
  keyConflict: SavedServer | null;
  nickname: string;
  password: string;
  inviteCode: string;
  askPassword: boolean;
  askInvite: boolean;
  /** "Sou o dono deste servidor" is open: the hello carries the setup code (spec §3.3 "Dono"). */
  owner: boolean;
  /** The owner's setup code as typed. It lives only in this state: never saved, never logged. */
  setupCode: string;
  suggestion: string | null;
  error: AppErrorCode | null;
}

export type JoinAction =
  | { type: 'input'; value: string }
  | { type: 'parsed'; parsed: ParsedJoinInput; fingerprint: string | null }
  | { type: 'probed'; serverKeyId: string; fingerprint: string; saved: SavedServer[] }
  | { type: 'confirm' }
  | { type: 'owner'; open: boolean }
  | { type: 'field'; field: 'nickname' | 'password' | 'inviteCode' | 'setupCode'; value: string }
  | { type: 'submit' }
  | { type: 'failed'; code: AppErrorCode }
  | { type: 'joined' }
  | { type: 'back' };

export function initialJoin(nickname: string): JoinState {
  return {
    step: 'input', input: '', probeAddress: null, target: null, source: null, fingerprint: null, keyConflict: null,
    nickname, password: '', inviteCode: '', askPassword: false, askInvite: false, owner: false, setupCode: '', suggestion: null, error: null,
  };
}

/** spec §7: on NICK_TAKEN the interface suggests `name#2`, `name#3`, … within 32 visible characters. */
export function suggestNickname(nickname: string): string {
  const match = /^(.*)#(\d{1,6})$/u.exec(nickname.trim());
  const base = (match ? match[1]! : nickname.trim()) || 'ghost';
  const suffix = `#${match ? Number(match[2]) + 1 : 2}`;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(base), (s) => s.segment);
  return `${graphemes.slice(0, LIMITS.nicknameMaxVisible - suffix.length).join('').trimEnd()}${suffix}`;
}

/** A saved server that lists `address` under a different key: the user must be warned (spec §3.3). */
export function findKeyConflict(saved: SavedServer[], address: string, serverKeyId: string): SavedServer | null {
  return saved.find((s) => s.serverKeyId !== serverKeyId && s.addresses.includes(address)) ?? null;
}

/** Accepts a bare code, an invite link or a GL1- code in the invite field; null when none is found. */
export function extractInviteCode(value: string): string | null {
  const code = normalizeInviteCode(value);
  if (code !== null) return code;
  try {
    const parsed = parseJoinInput(value);
    return parsed.kind === 'invite' ? (parsed.invite.inviteCode ?? null) : null;
  } catch {
    return null;
  }
}

const SETUP_CODE_HEX = /^[0-9a-f]{32}$/;

/**
 * The owner's setup code in the grouped form the server prints, e.g.
 * "b1fe652f-73d05669-090d78d2-a9017231". Like the server's normalizeSetupCode it
 * ignores case, spaces and dashes; null when it is not 32 hex digits.
 */
export function formatSetupCode(input: string): string | null {
  const hex = input.toLowerCase().replace(/[\s-]/g, '');
  return SETUP_CODE_HEX.test(hex) ? [0, 8, 16, 24].map((i) => hex.slice(i, i + 8)).join('-') : null;
}

/** The join.connect request for the current state (credentials only when relevant). */
export function buildConnectRequest(s: JoinState): JoinConnectRequest {
  if (!s.target) throw new Error('no join target');
  const req: JoinConnectRequest = { addresses: s.target.addresses, serverKeyId: s.target.serverKeyId, nickname: s.nickname.trim() };
  const inviteCode = s.askInvite ? extractInviteCode(s.inviteCode) : (s.target.inviteCode ?? null);
  if (inviteCode) req.inviteCode = inviteCode;
  if (s.askPassword && s.password !== '') req.password = s.password;
  if (s.owner) {
    const setupCode = formatSetupCode(s.setupCode);
    // The reducer never lets a malformed code through: never join without it by accident.
    if (setupCode === null) throw new Error('malformed setup code');
    req.setupCode = setupCode;
  }
  if (s.target.name) req.name = s.target.name;
  return req;
}

/** Pure state machine of the Join screen: input → (probe →) confirm → details → connecting → done. */
export function joinReducer(s: JoinState, a: JoinAction): JoinState {
  switch (a.type) {
    case 'input':
      return { ...s, input: a.value, error: null };
    case 'parsed':
      if (a.parsed.kind === 'address') {
        return { ...s, step: 'probing', probeAddress: a.parsed.address, target: null, source: null, error: null };
      }
      return { ...s, step: 'confirm', source: 'invite', target: { ...a.parsed.invite }, fingerprint: a.fingerprint, keyConflict: null, error: null };
    case 'probed':
      if (s.step !== 'probing' || s.probeAddress === null) return s;
      return {
        ...s,
        step: 'confirm',
        source: 'tofu',
        target: { addresses: [s.probeAddress], serverKeyId: a.serverKeyId },
        fingerprint: a.fingerprint,
        keyConflict: findKeyConflict(a.saved, s.probeAddress, a.serverKeyId),
      };
    case 'confirm':
      return s.step === 'confirm' ? advance(s, 'details') : s;
    case 'owner':
      if (s.step !== 'confirm' && s.step !== 'details') return s;
      if (a.open) return { ...s, owner: true };
      return { ...s, owner: false, setupCode: '', error: s.error === 'BAD_SETUP_CODE' ? null : s.error };
    case 'field':
      return { ...s, [a.field]: a.value, error: null, suggestion: a.field === 'nickname' ? null : s.suggestion };
    case 'submit':
      return s.step === 'details' && s.target !== null ? advance(s, 'connecting') : s;
    case 'joined':
      return { ...s, step: 'done', password: '', setupCode: '', error: null };
    case 'back':
      return s.step === 'details' || s.step === 'confirm' ? { ...initialJoin(s.nickname), input: s.input } : s;
    case 'failed':
      return failed(s, a.code);
  }
}

/** Moves on, unless the owner section is open with a malformed code: then it stays and says so. */
function advance(s: JoinState, step: 'details' | 'connecting'): JoinState {
  if (!s.owner) return { ...s, step, error: null };
  const setupCode = formatSetupCode(s.setupCode);
  return setupCode === null ? { ...s, error: 'BAD_SETUP_CODE' } : { ...s, step, setupCode, error: null };
}

function failed(s: JoinState, code: AppErrorCode): JoinState {
  if (s.step !== 'connecting') return { ...s, step: 'input', probeAddress: null, error: code }; // parse or probe failed
  switch (code) {
    case 'INVITE_REQUIRED':
    case 'INVITE_INVALID':
      return { ...s, step: 'details', askInvite: true, error: code };
    case 'BAD_PASSWORD':
      return { ...s, step: 'details', askPassword: true, password: '', error: code };
    case 'NICK_TAKEN':
      return { ...s, step: 'details', suggestion: suggestNickname(s.nickname), error: code };
    case 'BAD_SETUP_CODE':
      // Wrong or already used: the section stays open with the code, so a typo can be fixed and retried.
      return { ...s, step: 'details', owner: true, error: code };
    case 'PIN_MISMATCH':
      // The key no longer matches what was confirmed: start over, never retry silently.
      return { ...initialJoin(s.nickname), input: s.input, error: code };
    default:
      return { ...s, step: 'details', error: code };
  }
}
