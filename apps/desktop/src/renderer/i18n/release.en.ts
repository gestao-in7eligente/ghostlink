import type { releasePtBR } from './release.pt-BR.js';

// Typed against pt-BR: a missing or extra key fails the typecheck.
export const releaseEn: Record<keyof typeof releasePtBR, string> = {
  'updates.banner.label': 'GhostLink update',
  'updates.banner.downloaded': 'New version {version} downloaded',
  'updates.banner.downloadedHint': 'It was already checked against the official release signature.',
  'updates.banner.restart': 'Restart to update',
  'updates.banner.later': 'Later',
  'updates.banner.rejected': 'Version {version} failed the signature check and was not installed.',
  'updates.banner.rejectedHint': 'Only download GhostLink from the official site or the GitHub releases page.',
  'updates.banner.dismiss': 'Dismiss',

  'updates.settings.title': 'Updates',
  'updates.settings.autoCheck': 'Check for updates automatically',
  'updates.settings.autoCheckHint':
    'At startup and every 6 hours, the app looks at the GhostLink releases on GitHub. It is the app’s only contact with a third party. An update is only installed when it carries the signature of the official release key.',
  'updates.settings.version': 'Installed version: {version}',
  'updates.settings.unsupported': 'Automatic updates only work in the installed Windows app. New versions are on the GhostLink site.',

  'updates.status.idle': 'No pending update.',
  'updates.status.disabled': 'Automatic checks are off.',
  'updates.status.checking': 'Checking for updates…',
  'updates.status.downloading': 'Downloading version {version}… {percent}%',
  'updates.status.downloaded': 'Version {version} is ready. Restart to update.',

  'updates.splash.checking': 'Checking for updates…',
  'updates.splash.downloading': 'Downloading update… {percent}%',
  'updates.splash.installing': 'Installing…',
  'updates.splash.skip': 'Open without updating',
};
