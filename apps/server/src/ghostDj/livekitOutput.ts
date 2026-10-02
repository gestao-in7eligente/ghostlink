import { AudioFrame, AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, dispose } from '@livekit/rtc-node';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from './ffmpeg.js';
import type { AudioOutput } from './output.js';
import { startSignalRelay, type SignalRelay } from './signalRelay.js';

/** How much sound may wait in LiveKit's buffer: short, so pause and skip are heard at once. */
const QUEUE_MS = 400;
/**
 * Opus for music: stereo (the relay marks the track stereo, so LiveKit answers `stereo=1` and
 * libwebrtc uses Opus's music mode) at 160 kbps. Measured against the source (v0.5.1): every
 * band from 20 Hz to 20 kHz within 0.2 dB, the stereo image kept and the waveform closer than
 * at 96 kbps (median SNR 21 dB against 17 dB).
 */
const MAX_BITRATE = 160_000n;

/**
 * The DJ as a LiveKit participant (spec §2): it joins the server's own LiveKit on its loopback
 * port, through a signal relay (signalRelay.ts), with a token the server minted (microphone
 * only, subscribes to nothing) and publishes one stereo audio track fed from PCM frames.
 * @livekit/rtc-node is a native add-on: this file is imported only when the DJ first joins a channel.
 */
export class LivekitOutput implements AudioOutput {
  readonly #room = new Room();
  readonly #source = new AudioSource(SAMPLE_RATE, CHANNELS, QUEUE_MS);
  #relay: SignalRelay | null = null;
  #closing = false;
  #listener: (() => void) | null = null;

  async connect(url: string, token: string, icePort: number | null = null): Promise<void> {
    this.#room.on(RoomEvent.Disconnected, () => {
      if (!this.#closing) this.#listener?.();
    });
    this.#relay = await startSignalRelay({ target: url, icePort });
    await this.#room.connect(this.#relay.url, token, { autoSubscribe: false, dynacast: false });
    const track = LocalAudioTrack.createAudioTrack('ghost-dj', this.#source);
    // Music: no DTX (it would cut quiet passages).
    const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, audioEncoding: { maxBitrate: MAX_BITRATE } });
    await this.#room.localParticipant!.publishTrack(track, options);
  }

  write(frame: Int16Array): Promise<void> {
    return this.#source.captureFrame(new AudioFrame(frame, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
  }

  clear(): void {
    if (!this.#source.closed) this.#source.clearQueue();
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.#room.disconnect().catch(() => {});
    await this.#source.close().catch(() => {});
    await this.#relay?.close().catch(() => {});
  }

  onClosed(listener: () => void): void {
    this.#listener = listener;
  }
}

export function createLivekitOutput(): AudioOutput {
  return new LivekitOutput();
}

/** Loads the native add-on and makes one audio source (`ghostlink-server ghost-dj`): throws when it cannot. */
export async function checkLivekitAudio(): Promise<void> {
  const source = new AudioSource(SAMPLE_RATE, CHANNELS, QUEUE_MS);
  await source.close();
  await dispose();
}

/** Ends rtc-node's native side (its threads would keep the process alive after the server stopped). */
export function disposeLivekit(): Promise<void> {
  return dispose();
}
