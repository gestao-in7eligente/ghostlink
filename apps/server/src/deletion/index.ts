// The `serverDelete` server module: deleting a server (spec 2026-10-01-sair-e-excluir-servidor-design.md).
export {
  SERVER_DELETE_MODULE,
  createServerDeleteModule,
  type ServerDeleteModule,
  type ServerDeleteModuleOptions,
} from './module.js';
export { deletionState, type DeletionState } from './state.js';
