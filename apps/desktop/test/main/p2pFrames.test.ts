import { describe, expect, it } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  FrameError,
  MAX_INBOX_REQUEST_BYTES,
  MAX_JSON_BYTES,
  NICKNAME_WIRE_MAX,
  decodeMessage,
  encodeMessage,
  wireNickname,
  type P2pMessage,
} from '../../src/main/p2p/frames.js';

const SIG = 'A'.repeat(86);
/** A friend.request's code proof: base64url of 32 bytes. */
const PROOF = `${'B'.repeat(42)}A`;

/** A frame by hand: 1 type byte, uint32 BE length, body. */
function frame(type: number, body: Uint8Array | string, declared?: number): Buffer {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = type;
  header.writeUInt32BE(declared ?? bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
const json = (value: unknown) => frame(1, JSON.stringify(value));

describe('frames (friends spec §3.3)', () => {
  it.each<[P2pMessage]>([
    [{ t: 'hello', v: 1, nickname: 'Ana' }],
    [{ t: 'hello', v: 1, nickname: '' }],
    [{ t: 'inbox.hello', sig: SIG }],
    [{ t: 'friend.request', nickname: 'João ✨', proof: PROOF }],
    [{ t: 'friend.accept' }],
    [{ t: 'friend.remove' }],
    [{ t: 'ping' }],
    [{ t: 'pong' }],
  ])('round-trips %j', (message) => {
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('is 1 type byte (1 = JSON), the body length as uint32 BE, then the body', () => {
    const bytes = Buffer.from(encodeMessage({ t: 'ping' }));
    expect(bytes[0]).toBe(1);
    expect(bytes.readUInt32BE(1)).toBe(bytes.length - 5);
    expect(JSON.parse(bytes.subarray(5).toString('utf8'))).toEqual({ t: 'ping' });
  });

  it('takes a JSON body of exactly 256 KiB and refuses one byte more, before parsing it', () => {
    const fill = (size: number) => `{"t":"hello","v":1,"nickname":"${'a'.repeat(size - 33)}"}`;
    expect(Buffer.byteLength(fill(MAX_JSON_BYTES))).toBe(MAX_JSON_BYTES);
    // Exactly at the limit the frame is read (and then fails the schema: the nickname is too long).
    expect(() => decodeMessage(frame(1, fill(MAX_JSON_BYTES)))).toThrow(/schema/);
    expect(() => decodeMessage(frame(1, fill(MAX_JSON_BYTES + 1)))).toThrow(/too large/);
    // A header that declares a huge body is refused even when the body never came.
    expect(() => decodeMessage(frame(1, '', 0xffffffff))).toThrow(/too large/);
  });

  it('holds an inbox request to 1 KiB', () => {
    const request = encodeMessage({ t: 'friend.request', nickname: 'Ana', proof: PROOF });
    expect(decodeMessage(request, MAX_INBOX_REQUEST_BYTES)).toEqual({ t: 'friend.request', nickname: 'Ana', proof: PROOF });
    const padded = frame(1, `{"t":"friend.request","nickname":"Ana","proof":"${PROOF}"}${' '.repeat(1024)}`);
    expect(decodeMessage(padded)).toEqual({ t: 'friend.request', nickname: 'Ana', proof: PROOF });
    expect(() => decodeMessage(padded, MAX_INBOX_REQUEST_BYTES)).toThrow(/too large/);
  });

  it.each<[string, Uint8Array]>([
    ['an empty frame', new Uint8Array(0)],
    ['a cut header', Buffer.from([1, 0, 0])],
    ['an unknown frame type', frame(3, '{"t":"ping"}')],
    ['a file chunk (a later phase)', frame(2, 'abc')],
    ['type 0', frame(0, '{"t":"ping"}')],
    ['a body shorter than declared', frame(1, '{"t":"ping"}', 13)],
    ['bytes after the body', Buffer.concat([json({ t: 'ping' }), Buffer.from(' ')])],
    ['two frames in one message', Buffer.concat([json({ t: 'ping' }), json({ t: 'pong' })])],
    ['an empty body', frame(1, '')],
    ['malformed UTF-8', frame(1, Buffer.from([0x7b, 0xff, 0x7d]))],
    ['malformed JSON', frame(1, '{"t":"ping"')],
    ['a JSON array', json([{ t: 'ping' }])],
    ['a JSON string', json('ping')],
    ['null', json(null)],
    ['no type', json({ nickname: 'Ana' })],
    ['an unknown type', json({ t: 'sync.have' })],
    ['a type that is not a string', json({ t: 1 })],
    ['an extra key on ping', json({ t: 'ping', at: 1 })],
    ['an extra key on hello', json({ t: 'hello', v: 1, nickname: 'Ana', admin: true })],
    ['an extra key on friend.request', json({ t: 'friend.request', nickname: 'Ana', proof: PROOF, offerId: 'x' })],
    ['friend.request without the code proof', json({ t: 'friend.request', nickname: 'Ana' })],
    ['a short code proof', json({ t: 'friend.request', nickname: 'Ana', proof: PROOF.slice(1) })],
    ['an extra key on friend.accept', json({ t: 'friend.accept', key: 'x' })],
    ['hello without a version', json({ t: 'hello', nickname: 'Ana' })],
    ['hello of another protocol version', json({ t: 'hello', v: 2, nickname: 'Ana' })],
    ['hello without a nickname', json({ t: 'hello', v: 1 })],
    ['a nickname that is not a string', json({ t: 'hello', v: 1, nickname: ['Ana'] })],
    ['a huge nickname', json({ t: 'friend.request', nickname: 'a'.repeat(257), proof: PROOF })],
    ['inbox.hello without a signature', json({ t: 'inbox.hello' })],
    ['a short signature', json({ t: 'inbox.hello', sig: SIG.slice(1) })],
    ['a signature that is not base64url', json({ t: 'inbox.hello', sig: `${SIG.slice(1)}+` })],
    ['__proto__ as the type carrier', frame(1, '{"__proto__":{"t":"ping"}}')],
  ])('refuses %s', (_label, bytes) => {
    expect(() => decodeMessage(bytes)).toThrow(FrameError);
  });

  it('cuts a nickname to 256 characters without splitting one, so any request fits in 1 KiB', () => {
    expect(wireNickname('Ana')).toBe('Ana');
    expect(wireNickname('a'.repeat(300))).toHaveLength(NICKNAME_WIRE_MAX);
    const emoji = wireNickname(`a${'\u{1F600}'.repeat(200)}`);
    expect(emoji).toHaveLength(255);
    expect(emoji).not.toMatch(/\p{Cs}/u); // no half of a surrogate pair
    // The worst case in UTF-8: 3 bytes for every character.
    const request = encodeMessage({ t: 'friend.request', nickname: wireNickname('\u0E49'.repeat(400)), proof: PROOF });
    expect(request.length).toBeLessThanOrEqual(MAX_INBOX_REQUEST_BYTES);
    expect(decodeMessage(request, MAX_INBOX_REQUEST_BYTES).t).toBe('friend.request');
  });

  it('never sends what it would refuse', () => {
    expect(() => encodeMessage({ t: 'hello', v: 1, nickname: 'a'.repeat(257) })).toThrow(FrameError);
    expect(() => encodeMessage({ t: 'ping', extra: 1 } as unknown as P2pMessage)).toThrow(FrameError);
    expect(() => encodeMessage({ t: 'nope' } as unknown as P2pMessage)).toThrow(FrameError);
  });
});
