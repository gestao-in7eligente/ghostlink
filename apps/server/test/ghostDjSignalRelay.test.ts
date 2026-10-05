import { describe, expect, it } from 'vitest';
import { loopbackIce, loopbackTwin, markStereo } from '../src/ghostDj/signalRelay.js';

// Protobuf by hand: a tag, a length, the bytes (livekit_rtc.proto field numbers).
const varint = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...varint(n >> 7)]);
const field = (no: number, payload: Uint8Array | string): Buffer => {
  const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
  return Buffer.concat([Buffer.from([...varint(no * 8 + 2), ...varint(bytes.length)]), bytes]);
};
const strings = (buf: Uint8Array): string => Buffer.from(buf).toString('latin1');

const TCP = 'candidate:213491638 1 tcp 1671430143 66.33.22.231 14102 typ host tcptype passive ufrag RkOj';

describe('Ghost DJ signal relay', () => {
  it('marks the DJ’s audio AddTrackRequest stereo, and nothing else', () => {
    // SignalRequest.add_track (4) { cid (1), name (2) }: type absent = AUDIO.
    const audio = field(4, Buffer.concat([field(1, 'TR_cid'), field(2, 'ghost-dj')]));
    const marked = Buffer.from(markStereo(audio));
    // stereo (12) = 1, audio_features (17) = [TF_STEREO], appended inside add_track.
    expect(marked.subarray(-6)).toEqual(Buffer.from([0x60, 0x01, 0x8a, 0x01, 0x01, 0x00]));
    expect(marked[0]).toBe(0x22);
    expect(marked[1]).toBe(audio[1]! + 6);

    const video = field(4, Buffer.concat([field(1, 'TR_cid'), Buffer.from([0x18, 0x01])]));
    expect(markStereo(video)).toBe(video);
    const offer = field(1, field(2, 'v=0'));
    expect(markStereo(offer)).toBe(offer);
    const garbage = Buffer.from([0xff, 0xff]);
    expect(markStereo(garbage)).toBe(garbage);
  });

  it('gives LiveKit’s ICE-TCP candidates a loopback twin ranked above them', () => {
    expect(loopbackTwin(TCP, 14102)).toBe('candidate:2134916380 1 tcp 1671430144 127.0.0.1 14102 typ host tcptype passive ufrag RkOj');
    expect(loopbackTwin(`a=${TCP}\r`, 14102)).toBe('a=candidate:2134916380 1 tcp 1671430144 127.0.0.1 14102 typ host tcptype passive ufrag RkOj\r');
    expect(loopbackTwin(TCP, 7881)).toBeNull();
    expect(loopbackTwin(TCP.replace('tcp', 'udp'), 14102)).toBeNull();
    expect(loopbackTwin(TCP.replace('66.33.22.231', '127.0.0.1'), 14102)).toBeNull();

    // SignalResponse.trickle (4) { candidateInit (1) }: the original, then its twin.
    const trickle = field(4, field(1, JSON.stringify({ candidate: TCP, sdpMid: '0', sdpMLineIndex: 0 })));
    const out = loopbackIce(trickle, 14102);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(trickle);
    expect(strings(out[1]!)).toContain('"candidate":"candidate:2134916380 1 tcp 1671430144 127.0.0.1 14102 typ host');
    expect(strings(out[1]!)).toContain('"sdpMid":"0"');

    // SignalResponse.answer (2) { type (1), sdp (2) }: a twin line after each candidate line.
    const answer = field(2, Buffer.concat([field(1, 'answer'), field(2, `v=0\r\na=${TCP}\r\na=end\r\n`)]));
    const [edited] = loopbackIce(answer, 14102);
    expect(strings(edited!)).toContain(`a=${TCP}\r\na=candidate:2134916380 1 tcp 1671430144 127.0.0.1 14102 typ host tcptype passive ufrag RkOj\r\na=end`);
    expect(loopbackIce(answer, 7881)).toEqual([answer]);
  });
});
