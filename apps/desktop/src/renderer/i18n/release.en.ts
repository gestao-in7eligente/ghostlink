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
    'At startup and every 6 hours, the app looks at the GhostLink releases on GitHub. An update is only installed when it carries the signature of the official release key. Besides GitHub, the app only talks to third parties while "Be available to friends" is on: it then uses the public friends network (the Hyperswarm DHT) and connects straight to your friends’ computers.',
  'updates.settings.version': 'Installed version: {version}',
  'updates.settings.unsupported': 'Automatic updates only work in the installed Windows app. New versions are on the GhostLink site.',

  'updates.status.idle': 'No pending update.',
  'updates.status.disabled': 'Automatic checks are off.',
  'updates.status.checking': 'Checking for updates…',
  'updates.status.upToDate': 'You are on the latest version.',
  'updates.status.checkFailed': 'Could not check for updates right now. Check your connection and try again.',
  'updates.status.downloading': 'Downloading {version}… {percent}%',
  'updates.status.downloaded': '{version} is ready to install.',

  'updates.page.checkNow': 'Check for updates',
  'updates.page.checking': 'Checking…',
  'updates.page.checkedToday': 'Last checked: today at {time}.',
  'updates.page.checkedOn': 'Last checked: {date} at {time}.',
  'updates.page.progress': 'Download of {version}',
  'updates.page.downloadingHint': 'Once downloaded, it is checked against the official release signature before it can be installed.',
  'updates.page.downloadedHint': 'Already checked against the official release signature. The app closes, installs the new version and opens again by itself.',
  'updates.page.restart': 'Update and restart',
  'updates.page.newNotes': 'What’s new in {version}',
  'updates.page.installedNotes': 'What changed in your version ({version})',
  'updates.page.notesLoading': 'Loading what’s new…',
  'updates.page.notesUnavailable': 'Could not load what’s new in {version}.',
  'updates.page.notesMissing': 'There are no notes for {version}.',
  'updates.page.notesOnGitHub': 'See on GitHub',

  'updates.splash.checking': 'Checking for updates…',
  'updates.splash.downloading': 'Downloading update… {percent}%',
  'updates.splash.installing': 'Installing…',
  'updates.splash.skip': 'Open without updating',
};
