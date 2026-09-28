// Entry point of the utility process that runs a hosted GhostLink server (spec §9).
// electron-vite bundles it as out/main/serverEntry.js, next to the migrations it needs.
import { runHostedServer } from './hostedServer.js';

void runHostedServer(process.parentPort, process.argv.slice(2), { exit: (code) => process.exit(code) });
