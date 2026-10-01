// Voice track public API (release plan "Renderer" seams). The main layout plugs these in:
//   - VoiceChannelParticipants({ channelId }) under each voice channel row;
//   - VoicePanel() as the top row of the user panel card, VoiceControls() in its bottom row;
//   - VoiceStage({ channelId }) in the center when a voice channel is open;
//   - joinVoice(channelId) as the layout's onJoinVoice handler;
//   - VoiceSettings() inside the user settings screen, MemberVolume in a member's menu;
//   - provideVoiceDirectory(...) to feed names, channels and permissions from live stores.
import { MemberVolume } from './ParticipantMenu.js';
import { joinVoice } from './runtime.js';
import { VoiceChannelParticipants } from './VoiceChannelParticipants.js';
import { VoiceControls } from './VoiceControls.js';
import { VoicePanel } from './VoicePanel.js';
import { VoiceSettings } from './VoiceSettings.js';
import { VoiceStage } from './VoiceStage.js';

export { MemberVolume, ParticipantMenu, UserVolume } from './ParticipantMenu.js';
export { VoiceChannelParticipants } from './VoiceChannelParticipants.js';
export { VoiceControls } from './VoiceControls.js';
export { VoiceNoticeBar, VoicePanel } from './VoicePanel.js';
export { VoiceSettings } from './VoiceSettings.js';
export { VoiceStage } from './VoiceStage.js';

/** Everything the main layout's slot registry takes: `registerLayoutSlots(voiceSlots)`. */
export const voiceSlots = {
  VoiceChannelParticipants,
  VoicePanel,
  VoiceControls,
  VoiceStage,
  onJoinVoice: (channelId: string): void => void joinVoice(channelId),
  MemberMenuExtras: MemberVolume,
};

/** The user-settings section: `registerUserSettingsSection(voiceSettingsSection)`. */
export const voiceSettingsSection = { id: 'voice', title: 'voice.settings.title' as const, Component: VoiceSettings };
export type { VoiceDirectory } from './directory.js';
export {
  joinVoice,
  leaveVoice,
  moderateVoice,
  openCallServer,
  provideCallDirectory,
  provideVoiceDirectory,
  setUserVolume,
  toggleDeafen,
  toggleMute,
  useCallDirectory,
  useVoiceAvailable,
  useVoiceDirectory,
  useVoiceRuntime,
} from './runtime.js';
export { useVoiceSettings, type VoiceSettings as VoiceSettingsValues } from './settings.js';
export { callElsewhere, callServerId, useVoiceStore, type VoiceState } from './state.js';
