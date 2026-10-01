// Files in direct messages between two engines over a loopback DHT (attachments spec §3, §5):
// an image comes by itself and is checked, a file whose bytes do not match its hash is refused
// (nothing kept), a document waits for a click, and deleting the message takes the files away.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DmAttachment, DmEvent, DmMessage } from '../../src/shared/dmTypes.js';
import { IdentityStore } from '../../src/main/identity.js';
import { PART_BYTES } from '../../src/main/p2p/frames.js';
import { WINDOW_PARTS } from '../../src/main/p2p/blobs.js';
import { createDmFileRoute } from '../../src/main/p2p/dmFileRoute.js';
import { DM_FILES_DIR } from '../../src/main/p2p/dmFiles.js';
import { FriendsEngine } from '../../src/main/p2p/engine.js';
import { friendKeyFromSeed, keyToText } from '../../src/main/p2p/friendKey.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';

vi.setConfig({ testTimeout: 120_000 });

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let testnet: Testnet;
const engines: FriendsEngine[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterAll(async () => {
  await testnet.destroy();
});

function app(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-dm-files-'));
  dirs.push(dir);
  const identity = IdentityStore.load(dir, new FakeSafeStorage());
  identity.create();
  const events: DmEvent[] = [];
  const engine = new FriendsEngine({
    identity,
    settings: { get: () => ({ locale: 'en' as const, nickname: name }) },
    userDataDir: dir,
    emit: () => {},
    emitDm: (event) => events.push(event),
    bootstrap: testnet.bootstrap,
    bindHost: '127.0.0.1',
    retryDelayMs: () => 150,
  });
  engines.push(engine);
  const files = join(dir, DM_FILES_DIR);
  return {
    engine,
    events,
    dm: engine.dm,
    /** Where a kept file lies on this computer. */
    file: (hash: string) => join(files, hash),
    /** What is waiting in files/tmp (picked or arriving). */
    temp: () => readdirSync(join(files, 'tmp')),
    key: () => keyToText(friendKeyFromSeed(identity.friendSeed()).publicKey),
    online: async (other: { key(): string }) => (await engine.state()).friends.some((f) => f.key === other.key() && f.online),
    first: async (conv: string): Promise<DmMessage | undefined> => (await engine.dm.history(conv, null, 50)).at(-1),
  };
}
type App = ReturnType<typeof app>;

async function pair() {
  const ana = app('Ana');
  const bia = app('Bia');
  await ana.engine.sync();
  await bia.engine.sync();
  await ana.engine.add((await bia.engine.state()).code!);
  await until(async () => (await bia.engine.state()).friends.some((f) => f.state === 'pending_in'));
  await bia.engine.accept(ana.key());
  await until(async () => (await ana.online(bia)) && (await bia.online(ana)));
  const conv = (await ana.dm.open(bia.key())).id;
  return { ana, bia, conv };
}

/** A PNG header (IHDR with its sides) and `size` bytes in all: the type and sides read from it. */
function png(size: number, width = 640, height = 480): Uint8Array {
  const bytes = randomBytes(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(size - 9)]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function attachment(a: App, conv: string, hash: string): Promise<DmAttachment | undefined> {
  // The conversation exists on the receiving side once the first message arrived.
  const messages = await a.dm.history(conv, null, 50).catch(() => []);
  return messages.flatMap((m) => m.attachments).find((f) => f.hash === hash);
}

describe('files in direct messages over a loopback DHT (attachments spec §3)', () => {
  it('an image comes by itself, checked; a tampered part is refused; a document waits for a click; deleting takes them away', async () => {
    const { ana, bia, conv } = await pair();

    // Ana picks an image of 20 parts (more than one window) and a PDF, and sends both without text.
    const image = png(20 * PART_BYTES - 1234);
    const doc = pdf(3 * PART_BYTES + 7);
    expect(20).toBeGreaterThan(WINDOW_PARTS);
    const imageInfo = await ana.dm.attach(conv, 'foto.png', image);
    expect(imageInfo).toEqual({ hash: sha(image), name: 'foto.png', size: image.byteLength, kind: 'image', mime: 'image/png', width: 640, height: 480 });
    const docInfo = await ana.dm.attach(conv, 'nota/fiscal.pdf', doc);
    expect(docInfo).toMatchObject({ hash: sha(doc), name: 'nota_fiscal.pdf', kind: 'file', mime: 'application/pdf' });
    expect(existsSync(ana.file(imageInfo.hash))).toBe(false); // not kept until the message goes out
    const sent = await ana.dm.send(conv, '', null, [
      { hash: imageInfo.hash, name: imageInfo.name },
      { hash: docInfo.hash, name: 'nota.pdf' },
    ]);
    expect(sent.text).toBe('');
    expect(sent.attachments.map((f) => [f.name, f.state])).toEqual([
      ['foto.png', 'ready'],
      ['nota.pdf', 'ready'],
    ]);
    expect(readFileSync(ana.file(imageInfo.hash))).toEqual(Buffer.from(image));

    // Bia: the message arrives and the image follows by itself, whole and checked.
    await until(async () => (await attachment(bia, conv, imageInfo.hash))?.state === 'ready');
    expect(readFileSync(bia.file(imageInfo.hash))).toEqual(Buffer.from(image));
    expect(bia.events).toContainEqual({ type: 'file', hash: imageInfo.hash, state: 'loading', received: WINDOW_PARTS * PART_BYTES });
    // The renderer sees it through app://ghostlink/_dmfile, typed from the bytes.
    const route = createDmFileRoute((hash) => bia.engine.dmFile(hash));
    const served = await route(new Request(`app://ghostlink/_dmfile/${imageInfo.hash}`));
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(image));
    expect((await route(new Request(`app://ghostlink/_dmfile/${docInfo.hash}`))).status).toBe(404); // not here yet

    // The PDF waits for a click.
    expect(await attachment(bia, conv, docInfo.hash)).toMatchObject({ state: 'absent', received: 0 });

    // One part of Ana's copy goes bad: Bia asks, gets every part, and keeps nothing.
    const bad = Buffer.from(doc);
    bad[PART_BYTES + 100]! ^= 0xff;
    writeFileSync(ana.file(docInfo.hash), bad);
    await bia.dm.fetchFile(conv, docInfo.hash);
    await until(async () => (await attachment(bia, conv, docInfo.hash))?.state === 'failed');
    expect(existsSync(bia.file(docInfo.hash))).toBe(false);
    expect(bia.temp()).toEqual([]);
    expect(bia.engine.dmFile(docInfo.hash)).toBeNull();

    // With the right bytes back, "Tentar de novo" brings it.
    writeFileSync(ana.file(docInfo.hash), doc);
    await bia.dm.fetchFile(conv, docInfo.hash);
    await until(async () => (await attachment(bia, conv, docInfo.hash))?.state === 'ready');
    expect(readFileSync(bia.file(docInfo.hash))).toEqual(doc);
    const download = await route(new Request(`app://ghostlink/_dmfile/${docInfo.hash}`));
    expect(download.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(download.headers.get('Content-Disposition')).toBe('attachment');

    // Ana deletes the message: it goes for both, and so do the files nothing else carries.
    await ana.dm.remove(conv, sent.id);
    expect(existsSync(ana.file(imageInfo.hash))).toBe(false);
    await until(async () => (await bia.first(conv))?.deleted === true);
    expect((await bia.first(conv))?.attachments).toEqual([]);
    expect(existsSync(bia.file(imageInfo.hash))).toBe(false);
    expect(existsSync(bia.file(docInfo.hash))).toBe(false);
  });

  it('refuses what is not a file of the conversation', async () => {
    const { ana, bia, conv } = await pair();
    // A file nobody sent cannot be fetched, saved or served.
    const stranger = sha(randomBytes(10));
    await expect(bia.dm.fetchFile(conv, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bia.dm.saveFile(conv, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(bia.engine.dmFile(stranger)).toBeNull();
    // A file over 25 MB is refused before anything is kept; one never attached cannot be sent.
    await expect(ana.dm.attach(conv, 'big.bin', new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(ana.dm.send(conv, 'oi', null, [{ hash: stranger, name: 'x' }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // No text and no files is still nothing to send.
    await expect(ana.dm.send(conv, '  ', null, [])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
