// The identity dialogs, opened from anywhere with openIdentitySettings() /
// openBackupExport() / openBackupImport(); App mounts <IdentityScreens> once.
import type { IdentityStatus } from '../../../shared/ipcTypes.js';
import { useT } from '../../i18n/index.js';
import { HostDialog } from '../host/HostDialog.js';
import { ExportBackup, IdentitySettings, ImportBackup } from './IdentitySettings.js';
import { closeIdentityDialog, useIdentityUi } from './identityModel.js';

/** "Identidade" as a modal: what the user-settings gear opens until a settings screen exists. */
export function IdentitySettingsModal({ status, onChanged, onClose }: { status: IdentityStatus; onChanged: (s: IdentityStatus) => void; onClose: () => void }) {
  const t = useT();
  const show = useIdentityUi((s) => s.show);
  return (
    <HostDialog title={t('identity.settings.title')} closeLabel={t('host.dialog.close')} onClose={onClose} wide>
      <IdentitySettings status={status} onChanged={onChanged} onExportFirst={() => show('export')} />
    </HostDialog>
  );
}

export function IdentityScreens({ status, onChanged }: { status: IdentityStatus; onChanged: (status: IdentityStatus) => void }) {
  const t = useT();
  const dialog = useIdentityUi((s) => s.dialog);
  const changed = (next: IdentityStatus) => {
    closeIdentityDialog();
    onChanged(next);
  };
  switch (dialog) {
    case 'closed':
      return null;
    case 'settings':
      return <IdentitySettingsModal status={status} onChanged={changed} onClose={closeIdentityDialog} />;
    case 'export':
      return (
        <HostDialog title={t('identity.export.title')} closeLabel={t('host.dialog.close')} onClose={closeIdentityDialog}>
          <ExportBackup />
        </HostDialog>
      );
    case 'import':
      return (
        <HostDialog title={t('identity.import.title')} closeLabel={t('host.dialog.close')} onClose={closeIdentityDialog}>
          <ImportBackup status={status} onImported={changed} />
        </HostDialog>
      );
  }
}
