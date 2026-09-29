import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { MainLayout } from '../layout/MainLayout.js';

/** The connected screen: the main layout (spec §11.1 item 4). */
export function Connected({ welcome, onLeave }: { welcome: RendererWelcome; onLeave: () => void }) {
  return <MainLayout welcome={welcome} onLeave={onLeave} />;
}
