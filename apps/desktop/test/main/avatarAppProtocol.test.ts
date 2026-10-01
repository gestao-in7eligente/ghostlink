// The `_avatar` route inside the app:// handler (spec 2026-10-01 §3).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../helpers/tempDir.js';

const electron = vi.hoisted(() => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));
vi.mock('electron', () => electron);

const { createAppRequestHandler, registerAppProtocol } = await import('../../src/main/appProtocol.js');

const tmp = useTempDir();
let renderer: string;
const HASH = 'a'.repeat(64);

beforeEach(() => {
  electron.protocol.handle.mockReset();
  renderer = join(tmp.path, 'renderer');
  mkdirSync(renderer, { recursive: true });
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>GhostLink</title>');
});

const photo = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));

describe('app://ghostlink/_avatar/…', () => {
  it('hands every path under /_avatar to the photo route', async () => {
    const handle = createAppRequestHandler(renderer, { avatar: photo });
    for (const url of [`app://ghostlink/_avatar/${HASH}`, 'app://ghostlink/_avatar/whatever', 'app://ghostlink/_avatar']) {
      photo.mockClear();
      const res = await handle(new Request(url));
      expect(photo, url).toHaveBeenCalledTimes(1);
      expect(res.headers.get('content-type')).toBe('image/png');
    }
  });

  it('still serves the renderer for everything else', async () => {
    const handle = createAppRequestHandler(renderer, { avatar: photo });
    photo.mockClear();
    for (const url of ['app://ghostlink/', 'app://ghostlink/servers/x', 'app://ghostlink/_avatars', 'app://ghostlink/x/_avatar/a']) {
      const res = await handle(new Request(url));
      expect(await res.text(), url).toContain('<title>GhostLink</title>');
    }
    expect(photo).not.toHaveBeenCalled();
  });

  it('answers 404 under /_avatar when no photo route is wired, never index.html', async () => {
    const res = await createAppRequestHandler(renderer)(new Request(`app://ghostlink/_avatar/${HASH}`));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('registerAppProtocol wires the route into protocol.handle', async () => {
    registerAppProtocol(renderer, { avatar: photo });
    const [scheme, handler] = electron.protocol.handle.mock.calls[0] as [string, (r: Request) => Promise<Response>];
    expect(scheme).toBe('app');
    photo.mockClear();
    await handler(new Request(`app://ghostlink/_avatar/${HASH}`));
    expect(photo).toHaveBeenCalledTimes(1);
  });
});
