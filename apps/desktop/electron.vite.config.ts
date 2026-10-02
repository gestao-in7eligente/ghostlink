import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The server reads its SQL migrations at runtime from new URL('./migrations/', import.meta.url),
 * i.e. next to the bundle that contains it: out/main/migrations/ (plan 1a, contract note 9).
 */
function copyServerMigrations(): Plugin {
  return {
    name: 'ghostlink:copy-server-migrations',
    writeBundle(options) {
      if (!options.dir) throw new Error('the main build needs an output directory');
      cpSync(here('../server/src/db/migrations/'), join(options.dir, 'migrations'), { recursive: true });
    },
  };
}

/**
 * `virtual:ghostlink/release-notes`: release-notes/<version>.md of the version being built (the
 * package version, which is app.getVersion()), so the Updates page shows "O que mudou na sua
 * versão" without asking anyone. A version without a notes file yet builds with `markdown: null`
 * (the release workflow refuses to publish one).
 */
const RELEASE_NOTES_MODULE = 'virtual:ghostlink/release-notes';
function bundledReleaseNotes(): Plugin {
  const resolved = `\0${RELEASE_NOTES_MODULE}`;
  return {
    name: 'ghostlink:release-notes',
    resolveId: (id) => (id === RELEASE_NOTES_MODULE ? resolved : null),
    load(id) {
      if (id !== resolved) return null;
      const { version } = JSON.parse(readFileSync(here('package.json'), 'utf8')) as { version: string };
      const file = here(`../../release-notes/${version}.md`);
      const markdown = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (markdown !== null) this.addWatchFile(file);
      return `export const version = ${JSON.stringify(version)};\nexport const markdown = ${JSON.stringify(markdown)};\n`;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copyServerMigrations()],
    build: {
      target: 'node24',
      // The workspace packages export TypeScript source, so they must be bundled; every
      // other dependency stays in node_modules (electron-vite 5 option, replaces externalizeDepsPlugin).
      externalizeDeps: { exclude: ['@ghostlink/shared', '@ghostlink/server'] },
      rollupOptions: {
        input: {
          index: here('src/main/index.ts'),
          serverEntry: here('src/main/serverEntry.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      target: 'node24',
      rollupOptions: {
        // index: the main window. splash: the update splash (main/updateSplash.ts). drawOverlay: the
        // pencil over the shared screen (main/drawOverlay.ts). toast: the notification cards
        // (main/toasts.ts). They share no module, so each stays one file (a sandboxed preload cannot
        // require a chunk).
        input: {
          index: here('src/preload/index.ts'),
          splash: here('src/preload/splash.ts'),
          drawOverlay: here('src/preload/drawOverlay.ts'),
          toast: here('src/preload/toast.ts'),
        },
        // A sandboxed preload cannot be an ES module; .cjs keeps Node from reading it as ESM.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: here('src/renderer'),
    plugins: [react(), bundledReleaseNotes()],
    build: {
      target: 'chrome152',
      // `?url` scripts (the noise suppressors' AudioWorklets) and WebAssembly stay files under
      // app://ghostlink: the CSP's script-src never allows data: URLs, however small the file.
      assetsInlineLimit: (file) => (/\.(?:js|mjs|wasm)$/.test(file) ? false : undefined),
      // splash.html: the update splash shown while the app checks for updates (app://ghostlink/splash.html).
      // drawOverlay.html: the pencil's strokes over the shared monitor (app://ghostlink/drawOverlay.html).
      // toast.html: the notification cards in the corner of the screen (app://ghostlink/toast.html).
      rollupOptions: {
        input: {
          index: here('src/renderer/index.html'),
          splash: here('src/renderer/splash.html'),
          drawOverlay: here('src/renderer/drawOverlay.html'),
          toast: here('src/renderer/toast.html'),
        },
      },
    },
  },
});
