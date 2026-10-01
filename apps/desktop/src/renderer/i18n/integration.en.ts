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
  'home.nav': 'Home',
  'home.welcome': 'Welcome, {name}!',
  'home.active.title': 'Active now',
  'home.active.emptyTitle': "It's quiet for now...",
  'home.active.emptyText': 'When you host a server on this computer, it shows up here.',
  'home.active.hostedHere': 'Hosted on this computer',
  'home.active.running': 'Online',
  'home.active.starting': 'Starting…',
  'home.active.stopping': 'Stopping…',
  'home.active.stopped': 'Stopped',
  'home.active.failed': 'Failed to start',
  'home.active.members': '{count} of {max} members',
  'home.active.address': 'Address to invite: {address}',
  'home.active.open': 'Open',
  'home.active.start': 'Start',
  'home.active.manage': 'Manage',
  'home.panelStatus': 'At home',
};
