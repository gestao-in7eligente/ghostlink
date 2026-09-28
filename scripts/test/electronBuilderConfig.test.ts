import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
const read = (file: string) => readFileSync(join(desktop, file), 'utf8');

type Dict = Record<string, unknown>;
const config = parse(read('electron-builder.yml')) as Dict & {
  extraMetadata: Dict;
  electronFuses: Dict;
  win: Dict;
  nsis: Dict;
  mac: Dict & { extendInfo: Dict };
  dmg: Dict;
};
const pkg = JSON.parse(read('package.json')) as {
  main: string;
  author?: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('apps/desktop/electron-builder.yml', () => {
  it('uses the frozen app identity (spec §3.6)', () => {
    expect(config.appId).toBe(APP_ID);
    expect(config.productName).toBe(APP_NAME);
    // Packaged package.json: productName names the userData folder, name the install folder.
    // Without this they would derive from "@ghostlink/desktop".
    expect(config.extraMetadata).toEqual({ name: 'ghostlink', productName: APP_NAME });
  });

  it('packages only the build output, in an integrity-checked asar, without rebuilding or publishing', () => {
    expect(config.directories).toEqual({ output: 'dist', buildResources: 'build' });
    expect(config.files).toEqual(['out/**', 'package.json']);
    expect(pkg.main.replace(/^\.\//, '')).toMatch(/^out\//);
    expect(config.asar).toBe(true);
    expect(config.npmRebuild).toBe(false); // spec §15: @electron/rebuild would try MSVC
    expect(config.publish).toBeNull();
    // fetch-livekit verifies the pinned LiveKit release before it is packaged (spec §8.1).
    expect(pkg.scripts.dist).toBe('npm run build && node ../../scripts/fetch-livekit.mjs && electron-builder --config electron-builder.yml --publish never');
  });

  it('ships the LiveKit binary of the target platform next to the asar (spec §15)', () => {
    // ${os}-${arch} is the target (never ${platform}, the build host); main finds it at process.resourcesPath/livekit.
    expect(config.extraResources).toEqual([{ from: 'resources/livekit/${os}-${arch}', to: 'livekit' }]);
  });

  it('flips exactly the spec §12 fuses', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeCliInspectArguments: false,
      enableNodeOptionsEnvironmentVariable: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  it('builds a per-user one-click NSIS installer that keeps user data on uninstall', () => {
    expect(config.win).toEqual({ target: [{ target: 'nsis', arch: ['x64'] }] });
    expect(config.nsis).toEqual({
      oneClick: true,
      perMachine: false,
      deleteAppDataOnUninstall: false, // identity.bin lives in userData (spec §3.1)
      artifactName: '${productName}-Setup-${version}.${ext}',
      include: 'build/installer.nsh',
    });
  });

  it('builds ad-hoc signed, hardened DMGs for both Mac architectures, without zip', () => {
    expect(config.mac.target).toEqual([{ target: 'dmg', arch: ['arm64', 'x64'] }]);
    expect(config.mac.identity).toBe('-'); // null would skip signing and the fused binary would not launch
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(config.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
    expect(config.mac.minimumSystemVersion).toBe('13.0'); // a string: unquoted YAML 13.0 is the number 13
    expect(config.dmg).toEqual({ artifactName: '${productName}-${version}-mac-${arch}.${ext}' });
  });

  it('explains why GhostLink asks for the microphone and the camera', () => {
    expect(config.mac.extendInfo).toEqual({
      NSMicrophoneUsageDescription: 'GhostLink uses the microphone for voice chat.',
      NSCameraUsageDescription: 'GhostLink uses the camera for video calls.',
    });
  });

  it('references build resources that exist', () => {
    for (const file of [config.icon, config.nsis.include, config.mac.entitlements]) {
      expect(typeof file).toBe('string');
      expect(existsSync(join(desktop, file as string)), String(file)).toBe(true);
    }
  });
});

describe('apps/desktop/package.json (packaging)', () => {
  // electron-vite leaves every "dependencies" entry external, and electron-builder copies each
  // one (with its own dependencies) into app.asar; devDependencies never reach the package.
  // These are exactly the packages the main-process bundles import at run time (plan 1b's
  // build.test.ts checks that ws and zod stay external and that reflect-metadata loads before x509).
  // Add one only for a package that must stay external (a native module, electron-updater…).
  // livekit-server-sdk: the hosted server's LiveKit client; uiohook-napi: native global push-to-talk hook.
  const RUNTIME_DEPENDENCIES = ['@peculiar/x509', 'livekit-server-sdk', 'reflect-metadata', 'uiohook-napi', 'ws', 'zod'];

  it('ships only the packages the bundles load at run time', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(RUNTIME_DEPENDENCIES);
  });

  it('keeps ws a runtime dependency, so electron-vite never bundles it', () => {
    // Bundled, ws's optional `bufferutil` probe becomes an empty stub and every WebSocket frame
    // of 32+ bytes throws "bufferUtil.mask is not a function".
    expect(pkg.dependencies).toMatchObject({ ws: '8.22.0' });
  });

  it('bundles the workspace packages and the renderer libraries instead of shipping them', () => {
    // The workspace packages export TypeScript source; React, zustand and the font are in the renderer bundle.
    for (const name of ['@ghostlink/server', '@ghostlink/shared', 'react', 'react-dom', 'zustand', '@fontsource/inter']) {
      expect(pkg.devDependencies?.[name], name).toBeDefined();
    }
  });

  it('keeps the build toolchain out of the packaged app', () => {
    for (const tool of ['electron', 'electron-builder', 'electron-vite']) expect(pkg.dependencies?.[tool], tool).toBeUndefined();
    expect(pkg.devDependencies).toMatchObject({ electron: '44.4.5', 'electron-builder': '26.15.3', 'electron-vite': '5.0.0' });
  });

  it('names an author, which becomes the Windows CompanyName instead of Electron\'s "GitHub, Inc."', () => {
    expect(pkg.author).toBe('GhostLink contributors');
  });
});
