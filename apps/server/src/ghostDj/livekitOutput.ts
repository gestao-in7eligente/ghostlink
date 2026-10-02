import { AudioFrame, AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, dispose } from '@livekit/rtc-node';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from './ffmpeg.js';
import type { AudioOutput } from './output.js';

/** How much sound may wait in LiveKit's buffer: short, so pause and skip are heard at once. */
const QUEUE_MS = 400;

/**
 * The DJ as a LiveKit participant (spec §2): it joins the server's own LiveKit on its loopback
 * port with a token the server minted (microphone only, subscribes to nothing) and publishes one
 * audio track fed from PCM frames. @livekit/rtc-node is a native add-on: this file is imported
 * only when the DJ first joins a channel.
 */
export class LivekitOutput implements AudioOutput {
  readonly #room = new Room();
  readonly #source = new AudioSource(SAMPLE_RATE, CHANNELS, QUEUE_MS);
  #closing = false;
  #listener: (() => void) | null = null;

  async connect(url: string, token: string): Promise<void> {
    this.#room.on(RoomEvent.Disconnected, () => {
      if (!this.#closing) this.#listener?.();
    });
    await this.#room.connect(url, token, { autoSubscribe: false, dynacast: false });
    const track = LocalAudioTrack.createAudioTrack('ghost-dj', this.#source);
    // Music: no DTX (it would cut quiet passages), and room for stereo.
    const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, audioEncoding: { maxBitrate: 96_000n } });
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
