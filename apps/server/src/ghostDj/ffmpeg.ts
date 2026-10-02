import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { GHOST_DJ_LIMITS } from '@ghostlink/shared';
import { classifyYtdlpError, type TrackError, type YtDlpRunner } from './ytdlp.js';

/** PCM the DJ plays: signed 16-bit little-endian, 48 kHz, stereo (spec §2). */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** 20 ms frames. */
export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

/** One track's PCM, as it is decoded. */
export interface PcmSource {
  readonly stream: AsyncIterable<Buffer>;
  /** Stops it (skip, stop, shutdown): the processes end and the stream ends. */
  close(): void;
  /** Once it ended: why it could not be played to the end, or null. */
  result(): Promise<TrackError | null>;
}

/** `ffmpeg` when it runs on this machine, else null (then the DJ is unavailable). */
export function findFfmpeg(command = 'ffmpeg'): string | null {
  try {
    const r = spawnSync(command, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
    return r.status === 0 ? command : null;
  } catch {
    return null;
  }
}

/** ffmpeg reading any audio on stdin and writing the DJ's PCM on stdout, cut at the longest track allowed. */
export function ffmpegArgs(): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn', '-sn', '-dn',
    '-t', String(GHOST_DJ_LIMITS.maxTrackSeconds),
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    'pipe:1',
  ];
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('close', (code) => resolve(code));
  });
}

/**
 * yt-dlp downloading the video's audio into ffmpeg, which decodes it to PCM: the two processes
 * are piped to each other directly, with no shell.
 */
export function openYoutubePcm(o: { runner: YtDlpRunner; ffmpeg: string; videoUrl: string }): PcmSource {
  const download = o.runner.audio(o.videoUrl);
  if (!download) return failedSource('failed');
  const decode = spawn(o.ffmpeg, ffmpegArgs(), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let closed = false;
  let downloadErr = '';
  download.stderr.on('data', (c: Buffer) => {
    if (downloadErr.length < 16_384) downloadErr += c.toString('utf8');
  });
  // EPIPE when one side ends first: the exit codes tell what happened.
  download.stdout.on('error', () => {});
  decode.stdin.on('error', () => {});
  download.on('error', () => {});
  decode.on('error', () => {});
  download.stdout.pipe(decode.stdin);
  const ended = Promise.all([exited(download), exited(decode)]);
  return {
    stream: decode.stdout as Readable,
    close() {
      if (closed) return;
      closed = true;
      download.stdout.unpipe();
      download.kill('SIGKILL');
      decode.kill('SIGKILL');
      decode.stdout.destroy();
    },
    async result() {
      const [downloadCode, decodeCode] = await ended;
      if (closed) return null;
      if (downloadCode !== 0) return classifyYtdlpError(downloadErr);
      return decodeCode === 0 ? null : 'failed';
    },
  };
}

/** A source that has nothing to play. */
export function failedSource(error: TrackError): PcmSource {
  return {
    stream: (async function* () {})(),
    close() {},
    result: () => Promise.resolve(error),
  };
}
