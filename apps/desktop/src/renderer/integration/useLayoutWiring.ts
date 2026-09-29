import { useEffect } from 'react';
import { registerLayoutSlots, registerUserSettingsSection } from '../layout/slots.js';
import { openAddServer } from './addServerUi.js';
import { HostRailButton } from './HostRailButton.js';
import { IdentitySection } from './IdentitySection.js';

/** Plugs the Hosting and Identity features into the Text track's main layout slots. */
export function useLayoutWiring(): void {
  useEffect(() => {
    const offSlots = registerLayoutSlots({ onAddServer: openAddServer, RailExtras: HostRailButton });
    const offIdentity = registerUserSettingsSection({ id: 'identity', title: 'identity.settings.title', Component: IdentitySection });
    return () => {
      offSlots();
      offIdentity();
    };
  }, []);
}
