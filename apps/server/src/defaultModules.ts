import { createAvatarsModule } from './avatars/index.js';
import { createServerDeleteModule } from './deletion/index.js';
import { createFilesModule } from './files/index.js';
import type { ServerModule } from './modules.js';
import { createScreenDrawModule } from './screenDraw/index.js';
import { createStatusModule } from './status/index.js';
import { createTextModule } from './text/index.js';
import { createVoiceModule } from './voice/index.js';

/**
 * The feature modules a real server runs: the CLI `start` command and the
 * desktop Hosting mode pass this list to startServer(). Tests pass their own.
 * Each feature track adds its module here (one import + one entry), in an order
 * that satisfies getModule() dependencies (a module after those it calls in init).
 */
export function defaultModules(): ServerModule[] {
  // Text first: voice reads channels and permissions from it (VoiceAccess), avatars announces members through it.
  // Files after avatars: it registers the `attachment` purpose with the avatars module's upload hub.
  // After voice: the pencil (screenDraw) reads voice's rooms, and status reports whether anyone is in a call.
  // serverDelete last: it may close a session from its onSessionOpened, after every other module saw it open.
  return [createTextModule(), createVoiceModule(), createAvatarsModule(), createFilesModule(), createScreenDrawModule(), createStatusModule(), createServerDeleteModule()];
}
