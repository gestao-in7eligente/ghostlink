/** Defined by scripts/build.mjs and vitest.config.ts from package.json. */
declare const __GHOSTLINK_COMPAT_VERSION__: string | undefined;

/** This package's version (discord.js exports `version` too). */
export const version: string = typeof __GHOSTLINK_COMPAT_VERSION__ === 'string' ? __GHOSTLINK_COMPAT_VERSION__ : '0.0.0-dev';
