import { describe, expect, it } from 'vitest';
import { avatarFace, initialsFontSize } from '../../src/renderer/features/profile/avatarModel.js';
import { directoryFromWelcome } from '../../src/renderer/features/voice/directory.js';
import { voiceDirectoryFromText } from '../../src/renderer/integration/voiceDirectory.js';
import { BOB, CAROL, ME, member, snapshot, start } from './textFixtures.js';

const HASH = '0123456789abcdef'.repeat(4);

describe('avatarFace (spec §6: the photo when there is one, initials otherwise)', () => {
  it('shows the photo from the app:// route when there is a hash', () => {
    expect(avatarFace(HASH, null, 'Ana')).toEqual({ kind: 'image', src: `app://ghostlink/_avatar/${HASH}` });
  });

  it('shows the initials without a photo', () => {
    expect(avatarFace(null, null, 'Ana')).toEqual({ kind: 'initials', text: 'A' });
    expect(avatarFace(undefined, null, 'Ana Clara Souza')).toEqual({ kind: 'initials', text: 'AC' });
    expect(avatarFace(null, null, '  ')).toEqual({ kind: 'initials', text: '?' });
  });

  it('falls back to the initials when that photo failed to load, and tries a new one', () => {
    expect(avatarFace(HASH, HASH, 'Bia')).toEqual({ kind: 'initials', text: 'B' });
    const other = 'f'.repeat(64);
    expect(avatarFace(other, HASH, 'Bia')).toEqual({ kind: 'image', src: `app://ghostlink/_avatar/${other}` });
  });

  it('never puts anything but a 64-hex hash into the URL', () => {
    for (const bad of ['', 'abc', `${HASH}/../x`, HASH.toUpperCase(), `${HASH}0`]) expect(avatarFace(bad, null, 'Ana').kind, bad).toBe('initials');
  });
});

describe('initialsFontSize', () => {
  it('matches the Home rows at 32 px and scales with the circle', () => {
    expect(initialsFontSize(32)).toBe(13);
    expect(initialsFontSize(40)).toBe(16);
    expect(initialsFontSize(80)).toBe(32);
    expect(initialsFontSize(24)).toBe(10);
  });
});

describe('voice directories carry the photo (participants and the stage)', () => {
  it('from the live Text stores', () => {
    const snap = snapshot({ members: [member(ME, 'Eu'), member(BOB, 'Bob', { avatar: HASH }), member(CAROL, 'Carol')] });
    const dir = voiceDirectoryFromText(start(snap));
    expect(dir.avatar(BOB)).toBe(HASH);
    expect(dir.avatar(CAROL)).toBeNull();
    expect(dir.avatar('z'.repeat(32))).toBeNull();
  });

  it('from the welcome, leniently', () => {
    const dir = directoryFromWelcome(
      { members: [{ userId: BOB, nickname: 'Bob', avatar: HASH }, { userId: CAROL, nickname: 'Carol', avatar: '../etc/passwd' }, { userId: ME, nickname: 'Eu' }] },
      {},
    );
    expect(dir.avatar(BOB)).toBe(HASH);
    expect(dir.avatar(CAROL)).toBeNull();
    expect(dir.avatar(ME)).toBeNull();
  });
});
