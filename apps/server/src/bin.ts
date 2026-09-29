// Executable entry: esbuild bundles this file into dist/cli.js (the "ghostlink-server" bin).
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2));
