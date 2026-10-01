import type { serverUpdate as serverUpdatePt } from './serverUpdate.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const serverUpdate: Record<keyof typeof serverUpdatePt, string> = {
  'serverUpdate.label': 'Server update',
  'serverUpdate.waiting': 'This server runs {version}. It will be updated to {target} when nobody is in a call.',
  'serverUpdate.updating': 'Updating this server to {target}. Everyone connected reconnects automatically.',
  'serverUpdate.failed': 'This server runs {version}. The update to {target} did not finish; GhostLink tries again shortly.',
  'serverUpdate.railwayDisconnected': 'This server runs {version}. To update it to {target}, connect Railway again in Create a server → In the cloud (Railway).',
  'serverUpdate.manual': 'This server runs {version}. Update it to {target}',
  'serverUpdate.howTo': 'see how',
  'serverUpdate.updateNow': 'Update now',
  'serverUpdate.confirm.title': 'Update the server now?',
  'serverUpdate.confirm.body': 'Anyone in a call drops for a few seconds.',
  'serverUpdate.dismiss': 'Close notice',
};
