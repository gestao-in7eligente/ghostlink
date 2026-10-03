// The Sites category (v0.7.0).
import type { sites as sitesPt } from './sites.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const sites: Record<keyof typeof sitesPt, string> = {
  'sites.section': 'Sites',
  'sites.add': 'Add site',
  'sites.empty': 'Add the company’s sites: the Hermes posts what it does on each one in its channel.',
  'sites.createTitle': 'Add site',
  'sites.editTitle': 'Edit {name}',
  'sites.name': 'Name',
  'sites.nameExample': 'Profeta Cristão ES',
  'sites.domain': 'Address',
  'sites.domainExample': 'es.profetacristao.com',
  'sites.domainHint': 'Only the domain, no path and no password.',
  'sites.channel': 'Channel',
  'sites.newChannel': 'Create a new channel',
  'sites.newChannelHint': 'A text channel named after the address.',
  'sites.moveHint': 'The channel moves to Sites with all its history.',
  'sites.create': 'Add',
  'sites.save': 'Save',
  'sites.likely': 'Channels named like a site: {n}',
  'sites.registerLikely': 'Add them as sites',
  'sites.edit': 'Edit site',
  'sites.remove': 'Remove site',
  'sites.removeTitle': 'Remove {name} from the sites?',
  'sites.removeBody': 'The #{channel} channel stays, with all its history, and goes back to Text channels.',
  'sites.problem.name': 'Give the site a name.',
  'sites.problem.domain': 'Use only the domain, like es.profetacristao.com.',
  'sites.problem.limit': 'The limit is 50 sites.',
};
