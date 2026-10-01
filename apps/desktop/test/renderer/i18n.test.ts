import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES } from '../../src/shared/appErrors.js';
import { CHAT_SAME_IN_BOTH } from '../../src/renderer/i18n/chat.pt-BR.js';
import { VOICE_SAME_IN_BOTH } from '../../src/renderer/i18n/voice.pt-BR.js';
import { CATALOGS, errorCodeOf, errorMessage, translate, type MessageKey, type Translate } from '../../src/renderer/i18n/index.js';

const pt = CATALOGS['pt-BR'];
const en = CATALOGS.en;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n catalogs (spec §11)', () => {
  it('pt-BR and en have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
  });

  it('every key uses the same placeholders in both languages', () => {
    for (const key of Object.keys(pt) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(pt[key]));
    }
  });

  it('has a message for every server and client error code', () => {
    for (const code of APP_ERROR_CODES) {
      expect(pt[`errors.${code}` as MessageKey], code).toBeTruthy();
      expect(en[`errors.${code}` as MessageKey], code).toBeTruthy();
    }
  });

  it('the owner-code texts exist in both languages, the hint leaving room for the CLI command once', () => {
    for (const catalog of [pt, en]) {
      for (const key of ['join.owner.toggle', 'join.owner.label', 'join.owner.hint'] as const) expect(catalog[key], key).toBeTruthy();
      expect(catalog['join.owner.hint'].split('{command}')).toHaveLength(2);
    }
  });

  it('has no empty or untranslated texts', () => {
    const sameOnPurpose = new Set<string>(['app.beta', 'language.pt-BR', 'language.en', ...CHAT_SAME_IN_BOTH, ...VOICE_SAME_IN_BOTH]);
    for (const key of Object.keys(pt) as MessageKey[]) {
      expect(pt[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
      if (!sameOnPurpose.has(key)) expect(en[key], `${key} looks untranslated`).not.toBe(pt[key]);
    }
  });
});

describe('translate', () => {
  it('fills placeholders per language', () => {
    expect(translate('pt-BR', 'join.invite.title', { name: 'Casa' })).toBe('Convite para Casa');
    expect(translate('en', 'join.invite.title', { name: 'Casa' })).toBe('Invite to Casa');
    expect(translate('en', 'servers.as', { nickname: 0 })).toBe('as 0');
  });

  it('leaves unknown placeholders alone and ignores inherited properties', () => {
    expect(translate('en', 'join.invite.title')).toBe('Invite to {name}');
    expect(translate('en', 'join.invite.title', Object.create({ name: 'inherited' }) as Record<string, string>)).toBe('Invite to {name}');
  });

  it('inserts values as plain text (React escapes them later), without re-expanding placeholders', () => {
    expect(translate('en', 'join.invite.title', { name: '{name}<b>' })).toBe('Invite to {name}<b>');
  });
});

describe('error messages', () => {
  const t: Translate = (key, vars) => translate('en', key, vars);

  it('translates known codes and turns anything else into INTERNAL', () => {
    expect(errorMessage(t, 'PIN_MISMATCH')).toBe(en['errors.PIN_MISMATCH']);
    expect(errorMessage(t, 'BANNED')).toBe(en['errors.BANNED']);
    for (const unknown of ['FROM_THE_FUTURE', '__proto__', 'toString', '']) expect(errorMessage(t, unknown)).toBe(en['errors.INTERNAL']);
  });

  it('reads the code from a rejected window.ghostlink call', () => {
    expect(errorCodeOf(new Error('INVITE_REQUIRED'))).toBe('INVITE_REQUIRED');
    expect(errorCodeOf(new Error("Error invoking remote method 'x': boom"))).toBe('INTERNAL');
    expect(errorCodeOf('PIN_MISMATCH')).toBe('INTERNAL');
    expect(errorCodeOf(undefined)).toBe('INTERNAL');
  });
});
