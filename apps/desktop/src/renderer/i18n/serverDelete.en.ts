import type { serverDelete as serverDeletePt } from './serverDelete.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const serverDelete: Record<keyof typeof serverDeletePt, string> = {
  'serverExit.delete': 'Delete server',
  'serverExit.menu': '{name} options',

  'serverDelete.title': 'Delete {name}?',
  'serverDelete.body': 'The server goes offline for everyone now. It is erased for good in 48 h — messages, channels, roles and files. Until then, you can restore it.',
  'serverDelete.nameLabel': 'Type the server name to confirm',
  'serverDelete.confirm': 'Delete server',

  'serverDelete.banner': '{name} is offline and will be deleted in {time}.',
  'serverDelete.bannerLabel': 'Server being deleted',
  'serverDelete.restore': 'Restore server',
  'serverDelete.inHours': '{count} h',
  'serverDelete.inMinutes': '{count} min',
  'serverDelete.inMoments': 'a moment',

  'serverDelete.lostTitle': 'Server shut down',
  'serverDelete.deletedTitle': 'Server deleted',
  'serverDelete.deleting': '{name} was shut down by its owner and will be deleted on {date}.',
  'serverDelete.deletingSoon': '{name} was shut down by its owner and will be deleted soon.',
  'serverDelete.deleted': '{name} was deleted by its owner.',
  'serverDelete.deletedOwn': '{name} was deleted. Its data is erased.',

  'serverDelete.dangerZone': 'Danger zone',
  'serverDelete.dangerHint': 'Takes the server offline for everyone now and erases it for good in 48 h. Until then, it can be restored.',

  'serverExit.checking': 'Connecting to {name}…',
  'serverExit.unreachableTitle': 'Could not reach the server',
  'serverExit.unreachableBody': '{name} did not answer: {reason} You can take it off your list only.',
  'serverExit.removeOnly': 'Take it off my list only',
  'serverExit.ownerCannot': 'You own {name}, and the owner does not leave the server. This server cannot be deleted from the app yet: it has to be updated first.',
  'serverExit.ownerDeleting': '{name} is already offline and will be deleted in {time}. Open the server to restore it.',
  'serverExit.close': 'Close',
};
