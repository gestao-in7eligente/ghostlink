// Enterprise and the company Hermes (v0.6.0).
import type { enterprise as enterprisePt } from './enterprise.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const enterprise: Record<keyof typeof enterprisePt, string> = {
  'errors.ENTERPRISE_REQUIRED': 'This only works on an Enterprise server.',
  'errors.LICENSE_INVALID': 'That license is not valid for this server.',
  'errors.LICENSE_EXPIRED': 'That license has expired.',
  'enterprise.badge': 'Enterprise',
  'enterprise.badgeTitle': 'Enterprise server',
  'serverSettings.tab.enterprise': 'Enterprise',
  'enterprise.tab.intro': 'Enterprise servers have the company Hermes and no Ghost DJ.',
  'enterprise.tab.edition.enterprise': 'This server is Enterprise.',
  'enterprise.tab.edition.normal': 'This server is a normal one.',
  'enterprise.tab.none': 'No license pasted.',
  'enterprise.tab.state.valid': 'License for {company}, valid until {date}.',
  'enterprise.tab.state.expiring': 'License for {company}: expires on {date}.',
  'enterprise.tab.state.grace': 'License for {company}: expired on {date}. The server goes back to normal on {grace}.',
  'enterprise.tab.state.expired': 'License for {company}: expired on {date}. The server went back to normal.',
  'enterprise.tab.state.wrong-server': 'The stored license is for another server.',
  'enterprise.tab.state.invalid': 'The stored license could not be checked.',
  'enterprise.tab.identity': 'Server identity',
  'enterprise.tab.identityHint': 'The license is made for this identity. Send it to whoever issues the license.',
  'enterprise.tab.paste': 'Paste license',
  'enterprise.tab.pasteHint': 'A new license replaces the current one at once, without restarting the server.',
  'enterprise.tab.save': 'Save license',
  'enterprise.tab.saved': 'License saved.',
  'enterprise.banner.expiring': 'This server\'s Enterprise license expires on {date}.',
  'enterprise.banner.grace': 'The Enterprise license has expired. The server goes back to normal on {date}.',
  'enterprise.bannerLabel': 'Enterprise license notice',
};
