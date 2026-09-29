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
};
