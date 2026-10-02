/**
 * Where the DJ's sound goes: a participant in the voice channel's LiveKit room. The real one is
 * livekitOutput.ts (@livekit/rtc-node, loaded only when the DJ first plays); tests use a fake.
 */
export interface AudioOutput {
  /** Joins the room with the token voice.joinLocal() minted and publishes its microphone track. */
  connect(url: string, token: string): Promise<void>;
  /**
   * One 20 ms frame: s16le samples, 48 kHz, stereo interleaved (1920 values). Resolves once it is
   * queued; the queue is short, so this paces the caller to real time.
   */
  write(frame: Int16Array): Promise<void>;
  /** Drops the queued sound (pause, skip, stop take effect at once). */
  clear(): void;
  /** Leaves the room. */
  close(): Promise<void>;
  /** Called once when the room drops it without close(): kicked, moved, LiveKit down. */
  onClosed(listener: () => void): void;
}
