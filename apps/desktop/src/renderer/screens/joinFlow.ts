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
  suggestion: string | null;
  error: AppErrorCode | null;
}

export type JoinAction =
  | { type: 'input'; value: string }
  | { type: 'parsed'; parsed: ParsedJoinInput; fingerprint: string | null }
  | { type: 'probed'; serverKeyId: string; fingerprint: string; saved: SavedServer[] }
  | { type: 'confirm' }
  | { type: 'field'; field: 'nickname' | 'password' | 'inviteCode'; value: string }
  | { type: 'submit' }
  | { type: 'failed'; code: AppErrorCode }
  | { type: 'joined' }
  | { type: 'back' };

export function initialJoin(nickname: string): JoinState {
  return {
    step: 'input', input: '', probeAddress: null, target: null, source: null, fingerprint: null, keyConflict: null,
    nickname, password: '', inviteCode: '', askPassword: false, askInvite: false, suggestion: null, error: null,
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

/** The join.connect request for the current state (credentials only when relevant). */
export function buildConnectRequest(s: JoinState): JoinConnectRequest {
  if (!s.target) throw new Error('no join target');
  const req: JoinConnectRequest = { addresses: s.target.addresses, serverKeyId: s.target.serverKeyId, nickname: s.nickname.trim() };
  const inviteCode = s.askInvite ? extractInviteCode(s.inviteCode) : (s.target.inviteCode ?? null);
  if (inviteCode) req.inviteCode = inviteCode;
  if (s.askPassword && s.password !== '') req.password = s.password;
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
      return s.step === 'confirm' ? { ...s, step: 'details', error: null } : s;
    case 'field':
      return { ...s, [a.field]: a.value, error: null, suggestion: a.field === 'nickname' ? null : s.suggestion };
    case 'submit':
      return s.step === 'details' && s.target !== null ? { ...s, step: 'connecting', error: null } : s;
    case 'joined':
      return { ...s, step: 'done', password: '', error: null };
    case 'back':
      return s.step === 'details' || s.step === 'confirm' ? { ...initialJoin(s.nickname), input: s.input } : s;
    case 'failed':
      return failed(s, a.code);
  }
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
    case 'PIN_MISMATCH':
      // The key no longer matches what was confirmed: start over, never retry silently.
      return { ...initialJoin(s.nickname), input: s.input, error: code };
    default:
      return { ...s, step: 'details', error: code };
  }
}
