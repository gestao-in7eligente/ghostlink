import type { integration as ptBR } from './integration.pt-BR.js';

// Integration namespace (English). Typed against pt-BR: a missing or extra key fails the typecheck.
export const integration: Record<keyof typeof ptBR, string> = {
  'addServer.title': 'Add a server',
  'addServer.lead': 'Create a server for your group or join one that already exists.',
  'addServer.create.title': 'Create a server',
  'addServer.create.desc': 'Host it on your computer — you will be the owner.',
  'addServer.join.title': 'Join a server',
  'addServer.join.desc': 'Use an invite or an address.',
  'identity.section.manage': 'Manage identity and backup',

  'home.title': 'Home',
  'home.yourServers': 'Your servers',
  'home.noServers': 'You have not joined any server yet.',
  'home.welcome': 'Welcome, {name}!',
  'home.lead': 'Your servers live in the bar on the left. Create a server for your group or join one with an invite.',
  'home.startHosted': 'Start {name}',
  'home.startHostedDesc': 'Your server is stopped. Start it so your group can join.',
  'home.hosted': 'Your server',
  'home.hostedStopped': 'Stopped',
  'home.connecting': 'Connecting…',
  'home.remove': 'Remove',
  'home.removeLabel': 'Remove {name}',
  'home.removeConfirm': 'Remove {name}?',
  'home.cancel': 'Cancel',
  'home.panelStatus': 'At home',
};
