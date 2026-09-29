import { useEffect } from 'react';
import { UpdateSettings } from '../features/updates/UpdateSettings.js';
import { registerLayoutSlots, registerUserSettingsSection } from '../layout/slots.js';
import { openAddServer } from './addServerUi.js';
import { HostRailButton } from './HostRailButton.js';
import { IdentitySection } from './IdentitySection.js';

/** Plugs the Hosting, Identity and Release features into the Text track's main layout slots. */
export function useLayoutWiring(): void {
  useEffect(() => {
    const offSlots = registerLayoutSlots({ onAddServer: openAddServer, RailExtras: HostRailButton });
    const offIdentity = registerUserSettingsSection({ id: 'identity', title: 'identity.settings.title', Component: IdentitySection });
    // Spec §15: automatic update checks can be turned off in the settings (a release blocker if missing).
    const offUpdates = registerUserSettingsSection({ id: 'updates', title: 'updates.settings.title', Component: UpdateSettings });
    return () => {
      offSlots();
      offIdentity();
      offUpdates();
    };
  }, []);
}
