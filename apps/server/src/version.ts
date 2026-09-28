import pkg from '../package.json' with { type: 'json' };

/** Inlined from apps/server/package.json by every bundler (esbuild, electron-vite, vitest). */
export const SERVER_VERSION: string = pkg.version;

/** Placeholder origin for web invite links; replaced in M9 (single constant). */
export const WEB_SITE_BASE = 'https://ghostlink.invalid';
