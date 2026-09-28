import { describe, expect, it } from 'vitest';
import { formatFingerprint, formatInviteLink, parseJoinInput, toBase64Url } from '@ghostlink/shared';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import {
  buildConnectRequest,
  extractInviteCode,
  findKeyConflict,
  initialJoin,
  joinReducer,
  suggestNickname,
  type JoinAction,
  type JoinState,
} from '../../src/renderer/screens/joinFlow.js';

const KEY = toBase64Url(new Uint8Array(32).fill(1));
const OTHER_KEY = toBase64Url(new Uint8Array(32).fill(2));
const LINK = formatInviteLink({ addresses: ['203.0.113.5:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa' });

const run = (actions: JoinAction[], start = initialJoin('Ana')): JoinState => actions.reduce(joinReducer, start);

const viaInvite = (): JoinState => run([
  { type: 'input', value: LINK },
  { type: 'parsed', parsed: parseJoinInput(LINK), fingerprint: formatFingerprint(KEY) },
]);

const viaAddress = (saved: SavedServer[] = []): JoinState => run([
  { type: 'input', value: '192.168.0.2' },
  { type: 'parsed', parsed: parseJoinInput('192.168.0.2'), fingerprint: null },
  { type: 'probed', serverKeyId: KEY, fingerprint: formatFingerprint(KEY), saved },
]);

const connecting = (s: JoinState) => run([{ type: 'confirm' }, { type: 'submit' }], s);

describe('join flow — reaching the confirmation', () => {
  it('an invite goes straight to its confirmation with the fingerprint', () => {
    const s = viaInvite();
    expect(s).toMatchObject({ step: 'confirm', source: 'invite', fingerprint: formatFingerprint(KEY) });
    expect(s.target).toEqual({ addresses: ['203.0.113.5:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa' });
  });

  it('a bare address is probed first, then confirmed by fingerprint (TOFU)', () => {
    const probing = run([{ type: 'input', value: '192.168.0.2' }, { type: 'parsed', parsed: parseJoinInput('192.168.0.2'), fingerprint: null }]);
    expect(probing).toMatchObject({ step: 'probing', probeAddress: '192.168.0.2:7700' });
    expect(viaAddress()).toMatchObject({
      step: 'confirm',
      source: 'tofu',
      target: { addresses: ['192.168.0.2:7700'], serverKeyId: KEY },
      keyConflict: null,
    });
  });

  it('warns when a saved server used another key at the same address', () => {
    const saved: SavedServer = { id: 's1', name: 'Casa', addresses: ['192.168.0.2:7700'], serverKeyId: OTHER_KEY, nickname: 'Ana', addedAt: 1 };
    expect(viaAddress([saved]).keyConflict).toEqual(saved);
    expect(viaAddress([{ ...saved, serverKeyId: KEY }]).keyConflict).toBeNull();
  });

  it('a parse or probe failure returns to the input with the error', () => {
    expect(run([{ type: 'input', value: 'x' }, { type: 'failed', code: 'BAD_REQUEST' }])).toMatchObject({ step: 'input', error: 'BAD_REQUEST' });
    const probing = run([{ type: 'input', value: '10.0.0.9' }, { type: 'parsed', parsed: parseJoinInput('10.0.0.9'), fingerprint: null }]);
    expect(joinReducer(probing, { type: 'failed', code: 'UNREACHABLE' })).toMatchObject({ step: 'input', error: 'UNREACHABLE', probeAddress: null });
  });

  it('ignores a probe answer that arrives after the user went back', () => {
    const back = run([{ type: 'back' }], viaInvite());
    expect(joinReducer(back, { type: 'probed', serverKeyId: KEY, fingerprint: 'x', saved: [] })).toBe(back);
  });
});

describe('join flow — errors decide the next prompt (contract §5)', () => {
  it('INVITE_REQUIRED and INVITE_INVALID ask for an invite', () => {
    for (const code of ['INVITE_REQUIRED', 'INVITE_INVALID'] as const) {
      expect(joinReducer(connecting(viaAddress()), { type: 'failed', code })).toMatchObject({ step: 'details', askInvite: true, error: code });
    }
  });

  it('BAD_PASSWORD asks for the password and clears the wrong one', () => {
    const s = run([{ type: 'field', field: 'password', value: 'wrong' }], connecting(viaAddress()));
    expect(joinReducer(s, { type: 'failed', code: 'BAD_PASSWORD' })).toMatchObject({ step: 'details', askPassword: true, password: '', error: 'BAD_PASSWORD' });
  });

  it('NICK_TAKEN suggests nickname#2, and typing a new nickname clears the suggestion', () => {
    const taken = joinReducer(connecting(viaInvite()), { type: 'failed', code: 'NICK_TAKEN' });
    expect(taken).toMatchObject({ step: 'details', suggestion: 'Ana#2', error: 'NICK_TAKEN' });
    expect(joinReducer(taken, { type: 'field', field: 'nickname', value: 'Ana#2' })).toMatchObject({ suggestion: null, error: null });
  });

  it('PIN_MISMATCH starts over instead of offering a retry', () => {
    const s = joinReducer(connecting(viaAddress()), { type: 'failed', code: 'PIN_MISMATCH' });
    expect(s).toMatchObject({ step: 'input', target: null, error: 'PIN_MISMATCH', input: '192.168.0.2' });
  });

  it('other errors stay on the details step so the user can retry', () => {
    expect(joinReducer(connecting(viaInvite()), { type: 'failed', code: 'UNREACHABLE' })).toMatchObject({ step: 'details', error: 'UNREACHABLE' });
  });

  it('success forgets the typed password', () => {
    const s = run([{ type: 'joined' }], { ...connecting(viaAddress()), password: 'pw' });
    expect(s).toMatchObject({ step: 'done', password: '' });
  });
});

describe('buildConnectRequest', () => {
  it('sends the invite code from the link and the name hint', () => {
    expect(buildConnectRequest(run([{ type: 'confirm' }], viaInvite()))).toEqual({
      addresses: ['203.0.113.5:7700'], serverKeyId: KEY, nickname: 'Ana', inviteCode: 'ABCDEFGH23', name: 'Casa',
    });
  });

  it('sends credentials only once the server asked for them', () => {
    const plain = run([{ type: 'confirm' }, { type: 'field', field: 'password', value: 'pw' }], viaAddress());
    expect(buildConnectRequest(plain)).toEqual({ addresses: ['192.168.0.2:7700'], serverKeyId: KEY, nickname: 'Ana' });
    expect(buildConnectRequest({ ...plain, askPassword: true })).toMatchObject({ password: 'pw' });
    expect(buildConnectRequest({ ...plain, askInvite: true, inviteCode: LINK })).toMatchObject({ inviteCode: 'ABCDEFGH23' });
    expect(buildConnectRequest({ ...plain, askInvite: true, inviteCode: 'nonsense' })).not.toHaveProperty('inviteCode');
  });

  it('trims the nickname', () => {
    expect(buildConnectRequest({ ...run([{ type: 'confirm' }], viaAddress()), nickname: '  Bia ' }).nickname).toBe('Bia');
  });
});

describe('helpers', () => {
  it.each([
    ['Ana', 'Ana#2'],
    ['Ana#2', 'Ana#3'],
    ['Ana#9', 'Ana#10'],
    [' Ana ', 'Ana#2'],
    ['#7', 'ghost#8'],
    ['a'.repeat(32), `${'a'.repeat(30)}#2`],
    ['👻'.repeat(32), `${'👻'.repeat(30)}#2`],
  ])('suggestNickname(%j) → %j', (input, expected) => {
    expect(suggestNickname(input)).toBe(expected);
  });

  it('extractInviteCode accepts a bare code, a link or a paste code', () => {
    expect(extractInviteCode('abcdefgh23')).toBe('ABCDEFGH23');
    expect(extractInviteCode(LINK)).toBe('ABCDEFGH23');
    expect(extractInviteCode('192.168.0.2')).toBeNull();
    expect(extractInviteCode('')).toBeNull();
  });

  it('findKeyConflict only reports a different key at the same address', () => {
    const saved: SavedServer[] = [{ id: 'x', name: 'X', addresses: ['10.0.0.1:7700'], serverKeyId: OTHER_KEY, nickname: 'a', addedAt: 0 }];
    expect(findKeyConflict(saved, '10.0.0.1:7700', KEY)?.id).toBe('x');
    expect(findKeyConflict(saved, '10.0.0.2:7700', KEY)).toBeNull();
    expect(findKeyConflict(saved, '10.0.0.1:7700', OTHER_KEY)).toBeNull();
  });
});
