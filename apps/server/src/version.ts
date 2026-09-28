import pkg from '../package.json' with { type: 'json' };

/** Inlined from apps/server/package.json by every bundler (esbuild, electron-vite, vitest). */
export const SERVER_VERSION: string = pkg.version;

/** Public site that serves web invite links (`${WEB_SITE_BASE}/j/#GL1-…`); the fragment never reaches the server. */
export const WEB_SITE_BASE = 'https://gestao-in7eligente.github.io/ghostlink';
