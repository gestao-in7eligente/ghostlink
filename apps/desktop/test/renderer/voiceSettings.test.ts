import { describe, expect, it } from 'vitest';
import {
  VOICE_SETTINGS_KEY,
  defaultVoiceSettings,
  loadVoiceSettings,
  parseVoiceSettings,
  saveVoiceSettings,
  screenVolumeKey,
  volumeOf,
  withVolume,
  type KeyValueStorage,
} from '../../src/renderer/features/voice/settings.js';
import { keyLabel } from '../../src/renderer/features/voice/keys.js';
import { translate, type Translate } from '../../src/renderer/i18n/index.js';

const ANA = 'a'.repeat(32);
const BIA = 'b'.repeat(32);

function memory(initial?: string): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(VOICE_SETTINGS_KEY, initial);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('voice settings', () => {
  it('defaults: system devices, voice activity, no push-to-talk key, unmuted', () => {
    expect(defaultVoiceSettings).toEqual({
      inputDeviceId: null,
      outputDeviceId: null,
      mode: 'vad',
      pttCode: null,
      thresholdDb: -50,
      muted: false,
      deafened: false,
      volumes: {},
      cameraDeviceId: null,
      cameraQuality: '720p30',
    });
  });

  it('round-trips through storage', () => {
    const storage = memory();
    const s = { ...defaultVoiceSettings, mode: 'ptt' as const, pttCode: 'KeyV', thresholdDb: -40, inputDeviceId: 'mic-2', volumes: { s1: { [ANA]: 150 } } };
    saveVoiceSettings(storage, s);
    expect(loadVoiceSettings(storage)).toEqual(s);
  });

  it('keeps each valid field and drops anything malformed (never trusts storage)', () => {
    const parsed = parseVoiceSettings({
      mode: 'shout',
      pttCode: 'Key V<script>',
      thresholdDb: 12,
      inputDeviceId: 'x'.repeat(5_000),
      outputDeviceId: 'speakers',
      muted: 'yes',
      deafened: true,
      volumes: { s1: { [ANA]: 250, [BIA]: -3, 'not-a-user': 50, ['c'.repeat(32)]: 'loud' }, ['x'.repeat(200)]: { [ANA]: 50 } },
      extra: 1,
    });
    expect(parsed).toEqual({
      ...defaultVoiceSettings,
      thresholdDb: 0,
      outputDeviceId: 'speakers',
      deafened: true,
      volumes: { s1: { [ANA]: 200, [BIA]: 0 } },
    });
    for (const junk of [null, 'x', 42, [], { __proto__: { mode: 'ptt' } }]) expect(parseVoiceSettings(junk)).toEqual(defaultVoiceSettings);
  });

  it('survives unreadable or unavailable storage', () => {
    expect(loadVoiceSettings(memory('{not json'))).toEqual(defaultVoiceSettings);
    expect(loadVoiceSettings(null)).toEqual(defaultVoiceSettings);
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadVoiceSettings(throwing)).toEqual(defaultVoiceSettings);
    expect(() => saveVoiceSettings(throwing, defaultVoiceSettings)).not.toThrow();
  });

  it('per-user volume is 0–200 %, stored per server and user, 100 % by default', () => {
    let s = withVolume(defaultVoiceSettings, 's1', ANA, 180);
    s = withVolume(s, 's2', ANA, 20);
    expect(volumeOf(s, 's1', ANA)).toBe(180);
    expect(volumeOf(s, 's2', ANA)).toBe(20);
    expect(volumeOf(s, 's1', BIA)).toBe(100);
    expect(volumeOf(s, null, ANA)).toBe(100);
    expect(volumeOf(withVolume(s, 's1', ANA, 999), 's1', ANA)).toBe(200);
    expect(volumeOf(withVolume(s, 's1', ANA, -5), 's1', ANA)).toBe(0);
    // Back to 100 % forgets the entry.
    expect(withVolume(s, 's1', ANA, 100).volumes).toEqual({ s2: { [ANA]: 20 } });
    expect(volumeOf(s, 's1', '__proto__')).toBe(100);
  });

  it('a stream’s volume is kept apart from the same person’s voice, and survives storage (spec 2026-10-01 §5)', () => {
    let s = withVolume(defaultVoiceSettings, 's1', ANA, 60);
    s = withVolume(s, 's1', screenVolumeKey(ANA), 170);
    expect(screenVolumeKey(ANA)).toBe(`screen:${ANA}`);
    expect(volumeOf(s, 's1', ANA)).toBe(60);
    expect(volumeOf(s, 's1', screenVolumeKey(ANA))).toBe(170);
    expect(volumeOf(s, 's1', screenVolumeKey(BIA))).toBe(100);
    const storage = memory();
    saveVoiceSettings(storage, s);
    expect(loadVoiceSettings(storage).volumes).toEqual({ s1: { [ANA]: 60, [`screen:${ANA}`]: 170 } });
    // Only a user id after the prefix.
    expect(parseVoiceSettings({ volumes: { s1: { 'screen:x': 50, 'screen:': 50, [`camera:${ANA}`]: 50, [`screen:screen:${ANA}`]: 50 } } }).volumes).toEqual({});
  });
});

describe('push-to-talk key labels', () => {
  const pt: Translate = (key, vars) => translate('pt-BR', key, vars);
  const en: Translate = (key, vars) => translate('en', key, vars);
  it('reads like the keyboard', () => {
    expect(keyLabel('KeyV', en)).toBe('V');
    expect(keyLabel('Digit4', en)).toBe('4');
    expect(keyLabel('F13', en)).toBe('F13');
    expect(keyLabel('Backquote', en)).toBe('`');
    expect(keyLabel('Numpad5', en)).toBe('Num 5');
    expect(keyLabel('Space', en)).toBe('Space');
    expect(keyLabel('Space', pt)).toBe('Espaço');
    expect(keyLabel('ControlRight', en)).toBe('Right Ctrl');
    expect(keyLabel('ShiftLeft', pt)).toBe('Shift esquerdo');
    expect(keyLabel('MetaLeft', en)).toBe('Left Win');
    expect(keyLabel('CapsLock', en)).toBe('CapsLock');
  });
});
