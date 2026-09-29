// Slots in the main layout that other tracks fill (release plan "Seams"): the Voice
// track plugs in its participant list, panel, controls and stage; Hosting its "+"
// action; any track a user-settings section. Unfilled slots render nothing.
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { MessageKey } from '../i18n/index.js';

export interface UserSettingsSection {
  /** Stable id, e.g. "voice" or "identity". */
  id: string;
  /** i18n key of the section title. */
  title: MessageKey;
  Component: ComponentType;
}

export interface LayoutSlots {
  /** Under each voice channel in the sidebar: who is connected (Voice). */
  VoiceChannelParticipants: ComponentType<{ channelId: string }> | null;
  /** Top row of the user panel, shown while connected to voice (Voice). */
  VoicePanel: ComponentType | null;
  /** Mic and headphones buttons with their device menus, in the user panel (Voice). */
  VoiceControls: ComponentType | null;
  /** The center of the screen when a voice channel is open (Voice). */
  VoiceStage: ComponentType<{ channelId: string }> | null;
  /** Called when the user opens a voice channel (Voice's joinVoice). */
  onJoinVoice: ((channelId: string) => void) | null;
  /** Extra items in a member's context menu, e.g. per-user volume (Voice). */
  MemberMenuExtras: ComponentType<{ userId: string; close: () => void }> | null;
  /** The round "+" at the bottom of the server rail (Hosting). Default: back to the server list. */
  onAddServer: (() => void) | null;
  /** Extra round buttons in the server rail, above the "+" (Hosting). */
  RailExtras: ComponentType | null;
  /** Sections of the user settings, after Profile and Language. */
  userSettingsSections: readonly UserSettingsSection[];
}

type SingleSlot = Exclude<keyof LayoutSlots, 'userSettingsSections'>;

const EMPTY: LayoutSlots = {
  VoiceChannelParticipants: null,
  VoicePanel: null,
  VoiceControls: null,
  VoiceStage: null,
  onJoinVoice: null,
  MemberMenuExtras: null,
  onAddServer: null,
  RailExtras: null,
  userSettingsSections: [],
};

export const useLayoutSlots = create<LayoutSlots>()(() => EMPTY);

/**
 * Fills slots, e.g. `registerLayoutSlots({ VoicePanel, VoiceStage, onJoinVoice: joinVoice })`.
 * Returns a function that empties them again (only if still the registered value).
 */
export function registerLayoutSlots(slots: Partial<Pick<LayoutSlots, SingleSlot>>): () => void {
  useLayoutSlots.setState(slots);
  return () => {
    const current = useLayoutSlots.getState();
    const reset: Partial<Record<SingleSlot, null>> = {};
    for (const key of Object.keys(slots) as SingleSlot[]) {
      if (current[key] === slots[key]) reset[key] = null;
    }
    useLayoutSlots.setState(reset);
  };
}

/** Adds (or replaces, by id) a user-settings section. Returns a function that removes it. */
export function registerUserSettingsSection(section: UserSettingsSection): () => void {
  useLayoutSlots.setState((s) => ({ userSettingsSections: [...s.userSettingsSections.filter((x) => x.id !== section.id), section] }));
  return () => useLayoutSlots.setState((s) => ({ userSettingsSections: s.userSettingsSections.filter((x) => x !== section) }));
}

/** Tests only. */
export function resetLayoutSlots(): void {
  useLayoutSlots.setState(EMPTY, true);
}
