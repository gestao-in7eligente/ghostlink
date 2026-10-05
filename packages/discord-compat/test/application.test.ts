import { describe, expect, it, vi } from 'vitest';
import { ClientApplication, GhostLinkUnsupported, type Client } from '../src/index.js';

/** Just what ClientApplication uses of the client, with GhostLink requests recorded. */
function fakeClient() {
  const request = vi.fn(async (_t: string, d: unknown) => d);
  const client = { _selfId: () => 'b'.repeat(32), _selfName: () => 'Hermes', _request: request } as unknown as Client;
  return { app: new ClientApplication(client), request };
}

describe('client.application.edit (bot page spec)', () => {
  it('sends the description as bot.setDescription and resolves with the application', async () => {
    const { app, request } = fakeClient();
    await expect(app.edit({ description: 'Responde /ping com Pong!' })).resolves.toBe(app);
    expect(request).toHaveBeenCalledWith('bot.setDescription', { description: 'Responde /ping com Pong!' });
    await app.edit({ description: undefined });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses every other field by name before sending anything, and keeps the rest unsupported', async () => {
    const { app, request } = fakeClient();
    await expect(app.edit({ description: 'x', icon: 'icon.png' })).rejects.toBeInstanceOf(GhostLinkUnsupported);
    await expect(app.edit({ coverImage: null })).rejects.toThrow('ClientApplication.edit({ coverImage })');
    await expect(app.edit({ description: 42 as unknown as string })).rejects.toBeInstanceOf(TypeError);
    expect(request).not.toHaveBeenCalled();
    expect(() => (app as unknown as { description: unknown }).description).toThrow(GhostLinkUnsupported);
    expect(() => (app as unknown as { fetch: unknown }).fetch).toThrow(GhostLinkUnsupported);
  });
});
