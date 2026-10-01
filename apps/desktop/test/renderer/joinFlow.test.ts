import { describe, expect, it } from 'vitest';
import { formatFingerprint, formatInviteLink, parseJoinInput, toBase64Url } from '@ghostlink/shared';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import {
  buildConnectRequest,
  extractInviteCode,
  findKeyConflict,
  formatSetupCode,
  initialJoin,
  joinReducer,
  savedServerFor,
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

describe('owner setup code (spec §3.3 "Dono")', () => {
  const CODE = 'b1fe652f-73d05669-090d78d2-a9017231';
  const withCode = (value: string, s = viaAddress()) => run([{ type: 'owner', open: true }, { type: 'field', field: 'setupCode', value }], s);

  it.each([
    [CODE, CODE],
    [`  ${CODE.toUpperCase()}\n`, CODE],
    ['b1fe652f73d05669090d78d2a9017231', CODE],
    ['B1FE652F 73D05669 090D78D2 A9017231', CODE],
    ['b1fe 652f-73d0 5669\t090d-78d2 a901-7231', CODE],
  ])('formatSetupCode(%j) → the grouped form', (input, expected) => {
    expect(formatSetupCode(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'b1fe652f-73d05669-090d78d2',
    `${CODE}0`,
    'g1fe652f-73d05669-090d78d2-a9017231',
    'b1fe652f_73d05669_090d78d2_a9017231',
    'ABCDEFGH23',
  ])('formatSetupCode(%j) → null', (input) => {
    expect(formatSetupCode(input)).toBeNull();
  });

  it('the grouped form is the one the server prints and writes to setup-code.txt', () => {
    expect(formatSetupCode('0'.repeat(32))).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{8}){3}$/);
  });

  it('starts closed and sends no code', () => {
    const s = viaInvite();
    expect(s).toMatchObject({ owner: false, setupCode: '' });
    expect(buildConnectRequest(run([{ type: 'confirm' }], s))).not.toHaveProperty('setupCode');
  });

  it('confirming reformats the typed code, and the request carries it', () => {
    const s = run([{ type: 'confirm' }], withCode(' B1FE652F73D05669 090D78D2A9017231 '));
    expect(s).toMatchObject({ step: 'details', owner: true, setupCode: CODE, error: null });
    expect(buildConnectRequest(s)).toEqual({ addresses: ['192.168.0.2:7700'], serverKeyId: KEY, nickname: 'Ana', setupCode: CODE });
    expect(run([{ type: 'submit' }], s)).toMatchObject({ step: 'connecting', setupCode: CODE });
  });

  it('goes along with the invite of a link (the server waives it for the owner)', () => {
    const s = run([{ type: 'confirm' }], withCode(CODE, viaInvite()));
    expect(buildConnectRequest(s)).toMatchObject({ inviteCode: 'ABCDEFGH23', setupCode: CODE });
  });

  it('closing the section forgets the code', () => {
    const s = run([{ type: 'owner', open: false }, { type: 'confirm' }], withCode(CODE));
    expect(s).toMatchObject({ step: 'details', owner: false, setupCode: '' });
    expect(buildConnectRequest(s)).not.toHaveProperty('setupCode');
  });

  it('a malformed or empty code stops at the confirmation with BAD_SETUP_CODE, and typing clears it', () => {
    for (const value of ['', 'b1fe652f-73d0']) {
      const s = run([{ type: 'confirm' }], withCode(value));
      expect(s).toMatchObject({ step: 'confirm', error: 'BAD_SETUP_CODE', setupCode: value });
      expect(joinReducer(s, { type: 'field', field: 'setupCode', value: CODE })).toMatchObject({ step: 'confirm', error: null });
    }
    expect(run([{ type: 'confirm' }, { type: 'owner', open: false }], withCode('x'))).toMatchObject({ error: null, setupCode: '' });
  });

  it('a code broken on the details step is not sent', () => {
    const s = run([{ type: 'confirm' }, { type: 'field', field: 'setupCode', value: 'nope' }], withCode(CODE));
    expect(joinReducer(s, { type: 'submit' })).toMatchObject({ step: 'details', error: 'BAD_SETUP_CODE' });
    expect(() => buildConnectRequest(s)).toThrow();
  });

  it('BAD_SETUP_CODE from the server keeps the section and the code so the user can fix it and retry', () => {
    const wrong = 'b1fe652f-73d05669-090d78d2-a9017230';
    const failed = joinReducer(connecting(withCode(wrong)), { type: 'failed', code: 'BAD_SETUP_CODE' });
    expect(failed).toMatchObject({ step: 'details', owner: true, setupCode: wrong, error: 'BAD_SETUP_CODE' });
    const fixed = run([{ type: 'field', field: 'setupCode', value: CODE }], failed);
    expect(fixed.error).toBeNull();
    const retry = joinReducer(fixed, { type: 'submit' });
    expect(retry.step).toBe('connecting');
    expect(buildConnectRequest(retry).setupCode).toBe(CODE);
  });

  it('success forgets the code', () => {
    expect(run([{ type: 'joined' }], connecting(withCode(CODE)))).toMatchObject({ step: 'done', setupCode: '' });
  });

  it('the section only toggles on the confirmation and details steps', () => {
    const input = run([{ type: 'input', value: 'x' }]);
    expect(joinReducer(input, { type: 'owner', open: true })).toBe(input);
    const busy = connecting(withCode(CODE));
    expect(joinReducer(busy, { type: 'owner', open: false })).toBe(busy);
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

describe('an invite for a server already joined (owner request 2026-10-01)', () => {
  const saved = (over: Partial<SavedServer> = {}): SavedServer => ({
    id: 's1',
    name: 'Casa',
    addresses: ['10.0.0.9:7700'],
    serverKeyId: KEY,
    nickname: 'Aninha',
    addedAt: 1,
    ...over,
  });

  it('finds the saved server by its key', () => {
    expect(savedServerFor([saved({ serverKeyId: OTHER_KEY, id: 'x' }), saved()], KEY)?.id).toBe('s1');
    expect(savedServerFor([saved()], OTHER_KEY)).toBeNull();
  });

  it('goes straight in: the saved nickname, the invite addresses first, the invite code kept for someone who left since', () => {
    const s = joinReducer(viaInvite(), { type: 'known', saved: saved() });
    expect(s.step).toBe('connecting');
    expect(s.knownName).toBe('Casa');
    expect(buildConnectRequest(s)).toEqual({
      addresses: ['203.0.113.5:7700', '10.0.0.9:7700'],
      serverKeyId: KEY,
      nickname: 'Aninha',
      inviteCode: 'ABCDEFGH23',
      name: 'Casa',
    });
  });

  it('does the same for an address typed by hand, once its key is known', () => {
    const s = joinReducer(viaAddress(), { type: 'known', saved: saved() });
    expect(s.step).toBe('connecting');
    expect(buildConnectRequest(s).addresses).toContain('10.0.0.9:7700');
    expect(buildConnectRequest(s).nickname).toBe('Aninha');
  });

  it('never uses a saved server with another key', () => {
    const before = viaInvite();
    expect(joinReducer(before, { type: 'known', saved: saved({ serverKeyId: OTHER_KEY }) })).toBe(before);
  });

  it('keeps the typed nickname when the saved one is empty', () => {
    expect(joinReducer(viaInvite(), { type: 'known', saved: saved({ nickname: '' }) }).nickname).toBe('Ana');
  });

  it('falls back to the normal steps when the server wants an invite again', () => {
    const s = run([{ type: 'known', saved: saved() }, { type: 'failed', code: 'INVITE_INVALID' }], viaInvite());
    expect(s.step).toBe('details');
    expect(s.askInvite).toBe(true);
    expect(s.knownName).toBeNull();
  });
});
