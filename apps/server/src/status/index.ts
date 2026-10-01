// The `status` server module (spec 2026-10-01-servidores-acompanham-o-app-design.md §2):
// status.json for the VPS updater and GET /owner/status for the owner's app.
export {
  STATUS_FILE,
  STATUS_MODULE,
  createStatusModule,
  type StatusFile,
  type StatusModule,
  type StatusModuleOptions,
} from './module.js';
export { ownerPublicKey, parseOwnerStatusQuery, verifyOwnerStatusQuery } from './ownerStatus.js';
