// Stands in for the packaged app in smoke.test.ts. The first argument picks the behaviour.
// Exit codes are set through process.exitCode so piped output is always flushed.
import process from 'node:process';
import { setTimeout } from 'node:timers';

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case 'pass':
    console.log('[smoke] renderer loaded');
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    break;
  case 'exit-without-marker':
    console.log('another instance owns the lock; quitting');
    break;
  case 'crash':
    console.error('boom: the server entry failed to start');
    process.exitCode = 3;
    break;
  case 'marker-then-fail':
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    process.exitCode = 1;
    break;
  case 'hang':
    console.log('waiting forever');
    setTimeout(() => {}, 3_600_000);
    break;
  case 'echo-env':
    console.log(JSON.stringify({
      runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      smoke: process.env.GHOSTLINK_SMOKE ?? null,
      args: rest,
    }));
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    break;
  default:
    console.error(`fake-app: unknown mode ${mode}`);
    process.exitCode = 64;
}
