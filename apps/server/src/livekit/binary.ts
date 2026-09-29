import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVEKIT_EXE = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';

/** electron-builder's `${os}-${arch}` folder for this machine (scripts/fetch-livekit.mjs). */
export function livekitTargetDir(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform;
  return `${os}-${arch}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where livekit-server may live, most specific first:
 * 1. `explicit` (StartServerOptions.voice.binaryPath) — when given, it is the only candidate;
 * 2. $GHOSTLINK_LIVEKIT_BIN (operators);
 * 3. the packaged app: process.resourcesPath/livekit/ (electron-builder extraResources);
 * 4. next to the server bundle: <bundle dir>/livekit/ and <bundle dir>/../livekit/ (VPS install);
 * 5. the repository: <ancestor>/apps/desktop/resources/livekit/<os>-<arch>/ (dev and tests).
 */
export function livekitCandidates(opts: { explicit?: string; env?: NodeJS.ProcessEnv; resourcesPath?: string; moduleDir?: string } = {}): string[] {
  if (opts.explicit !== undefined) return [resolve(opts.explicit)];
  const env = opts.env ?? process.env;
  const out: string[] = [];
  if (env.GHOSTLINK_LIVEKIT_BIN) out.push(resolve(env.GHOSTLINK_LIVEKIT_BIN));
  const resourcesPath = opts.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) out.push(join(resourcesPath, 'livekit', LIVEKIT_EXE));
  const moduleDir = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  out.push(join(moduleDir, 'livekit', LIVEKIT_EXE), join(moduleDir, '..', 'livekit', LIVEKIT_EXE));
  let dir = moduleDir;
  for (let depth = 0; depth < 8; depth++) {
    out.push(join(dir, 'apps', 'desktop', 'resources', 'livekit', livekitTargetDir(), LIVEKIT_EXE));
    out.push(join(dir, 'resources', 'livekit', livekitTargetDir(), LIVEKIT_EXE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(out)];
}

/** The first existing livekit-server binary, or null when voice cannot run on this install. */
export function resolveLivekitBinary(opts: Parameters<typeof livekitCandidates>[0] = {}): string | null {
  return livekitCandidates(opts).find((p) => existsSync(p) && isFile(p)) ?? null;
}
