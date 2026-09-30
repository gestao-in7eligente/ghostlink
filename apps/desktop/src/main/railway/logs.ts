// The server's start lines in the deployment logs (apps/server/src/cli.ts):
//   Fingerprint: ABCDEFGH IJKLMNOP QRSTUVWX YZ234567
//   Setup code (use it once to become the owner): 3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718
// The logs come over the authenticated Railway API, so the fingerprint read here is what
// makes the first connection's pin more than blind TOFU.

export interface RailwayLogLine {
  timestamp?: string | null;
  message: string;
}

export interface ServerStart {
  fingerprint: string | null;
  setupCode: string | null;
}

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-_]`, 'g');
const FINGERPRINT = /Fingerprint:\s*([A-Za-z2-7]{8}(?:[ \t]+[A-Za-z2-7]{8}){3})\b/;
const SETUP_CODE = /Setup code[^:\n]*:\s*([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{8}){3})\b/;
const SETUP_CODE_ANYWHERE = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{8}){3}\b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Compares fingerprints written with any spacing or case. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').toUpperCase();
}

/**
 * The fingerprint and setup code the server printed. Lines may carry timestamps or ANSI
 * codes and repeat after restarts, so the latest of each wins (by timestamp when Railway
 * gives one, else in the order received).
 */
export function parseServerStart(lines: readonly RailwayLogLine[]): ServerStart {
  const ordered = lines
    .map((line, index) => ({ line, index, time: line.timestamp ? Date.parse(line.timestamp) : Number.NaN }))
    .sort((a, b) => (Number.isNaN(a.time) || Number.isNaN(b.time) || a.time === b.time ? a.index - b.index : a.time - b.time));
  const found: ServerStart = { fingerprint: null, setupCode: null };
  for (const { line } of ordered) {
    for (const text of stripAnsi(line.message).split(/\r?\n/)) {
      const fingerprint = FINGERPRINT.exec(text)?.[1];
      if (fingerprint) found.fingerprint = fingerprint.toUpperCase().split(/\s+/).join(' ');
      const setupCode = SETUP_CODE.exec(text)?.[1];
      if (setupCode) found.setupCode = setupCode.toLowerCase();
    }
  }
  return found;
}

/** A deployment log line fit for main.log: no ANSI, and never a setup code (it is a secret). */
export function redactLogLine(message: string): string {
  return stripAnsi(message).replace(SETUP_CODE_ANYWHERE, '[redacted]').slice(0, 2_000);
}
