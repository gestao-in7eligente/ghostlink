// Entry point of the utility process that runs a hosted GhostLink server (spec §9).
// electron-vite bundles it as out/main/serverEntry.js, next to the migrations it needs.
import { runHostedServer } from './hostedServer.js';
import { guardStream } from './log.js';

// Its stdout/stderr are pipes the app drains; if the app goes away first, a log line
// must not turn into an uncaught EPIPE that kills the server mid-shutdown.
guardStream(process.stdout);
guardStream(process.stderr);

void runHostedServer(process.parentPort, process.argv.slice(2), { exit: (code) => process.exit(code) });
