import { useEffect } from 'react';
import { openHostFlow } from '../features/host/hostUi.js';
import { UpdateSettings } from '../features/updates/UpdateSettings.js';
import { provideVoiceDirectory, voiceSettingsSection, voiceSlots } from '../features/voice/index.js';
import { registerLayoutSlots, registerUserSettingsSection } from '../layout/slots.js';
import { useTextStore } from '../stores/text.js';
import { useAddServerUi } from './addServerUi.js';
import { HostRailButton } from './HostRailButton.js';
import { IdentitySection } from './IdentitySection.js';
import { voiceDirectoryFromText } from './voiceDirectory.js';

/** Plugs the Hosting, Identity, Voice and Release features into the Text track's main layout slots. */
export function useLayoutWiring(): void {
  useEffect(() => {
    const offSlots = registerLayoutSlots({
      // Rail "+" → "Adicionar servidor": Criar opens the Host flow, Entrar the Join screen (over the connected server).
      onCreateServer: openHostFlow,
      onJoinServer: () => useAddServerUi.getState().openJoin(),
      RailExtras: HostRailButton,
      // Voice: participants under voice channels, the panel/controls in the user card, the stage, volume in member menus.
      ...voiceSlots,
    });
    const offIdentity = registerUserSettingsSection({ id: 'identity', title: 'identity.settings.title', Component: IdentitySection });
    const offVoice = registerUserSettingsSection(voiceSettingsSection);
    // Spec §15: automatic update checks can be turned off in the settings (a release blocker if missing).
    const offUpdates = registerUserSettingsSection({ id: 'updates', title: 'updates.settings.title', Component: UpdateSettings });

    // Live names, channels and permissions for the voice UI.
    provideVoiceDirectory(voiceDirectoryFromText(useTextStore.getState()));
    const offDirectory = useTextStore.subscribe((state) => provideVoiceDirectory(voiceDirectoryFromText(state)));

    return () => {
      offSlots();
      offIdentity();
      offVoice();
      offUpdates();
      offDirectory();
      provideVoiceDirectory(null);
    };
  }, []);
}
