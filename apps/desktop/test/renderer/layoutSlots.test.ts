import { afterEach, describe, expect, it } from 'vitest';
import { registerLayoutSlots, registerUserSettingsSection, resetLayoutSlots, useLayoutSlots } from '../../src/renderer/layout/slots.js';

afterEach(() => resetLayoutSlots());

const VoicePanel = () => null;
const VoiceStage = () => null;
const Other = () => null;

describe('layout slots (the seam for the Voice and Hosting tracks)', () => {
  it('starts empty, so the layout renders without the other tracks', () => {
    const s = useLayoutSlots.getState();
    expect(s.VoicePanel).toBeNull();
    expect(s.VoiceStage).toBeNull();
    expect(s.VoiceChannelParticipants).toBeNull();
    expect(s.VoiceControls).toBeNull();
    expect(s.onJoinVoice).toBeNull();
    expect(s.onAddServer).toBeNull();
    expect(s.userSettingsSections).toEqual([]);
  });

  it('registers components and handlers, and unregisters only what is still its own', () => {
    const joined: string[] = [];
    const off = registerLayoutSlots({ VoicePanel, VoiceStage, onJoinVoice: (id) => joined.push(id) });
    useLayoutSlots.getState().onJoinVoice!('V'.repeat(26));
    expect(joined).toEqual(['V'.repeat(26)]);
    expect(useLayoutSlots.getState().VoicePanel).toBe(VoicePanel);
    registerLayoutSlots({ VoiceStage: Other }); // someone replaced the stage meanwhile
    off();
    expect(useLayoutSlots.getState().VoicePanel).toBeNull();
    expect(useLayoutSlots.getState().VoiceStage).toBe(Other);
    expect(useLayoutSlots.getState().onJoinVoice).toBeNull();
  });

  it('adds user-settings sections by id', () => {
    const offA = registerUserSettingsSection({ id: 'voice', title: 'layout.userSettings', Component: VoicePanel });
    registerUserSettingsSection({ id: 'identity', title: 'layout.userSettings', Component: Other });
    registerUserSettingsSection({ id: 'voice', title: 'layout.userSettings', Component: Other });
    expect(useLayoutSlots.getState().userSettingsSections.map((x) => x.id)).toEqual(['identity', 'voice']);
    offA(); // the first "voice" was already replaced
    expect(useLayoutSlots.getState().userSettingsSections.map((x) => x.id)).toEqual(['identity', 'voice']);
  });
});
