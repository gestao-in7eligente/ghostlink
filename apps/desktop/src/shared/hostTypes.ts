// Host mode (spec §9) as the renderer sees it. Type-only, like ipcTypes.ts.
import type { AppErrorCode } from './appErrors.js';
import type { RendererWelcome } from './ipcTypes.js';

/** Host mode offers the modes that need nothing else; `password` is set later in the server settings. */
export type HostJoinMode = 'invite' | 'open';

/** What the "Hospedar" form sends (spec §11.1 screen 3). */
export interface HostConfig {
  name: string;
  port: number;
  joinMode: HostJoinMode;
  maxMembers: number;
}

export type HostState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

/** Where people can reach the hosted server; `loopback` is this computer only. */
export type HostAddressKind = 'loopback' | 'public' | 'lan' | 'radmin' | 'tailscale' | 'zerotier' | 'virtual';

export interface HostAddress {
  address: string; // host:port
  kind: HostAddressKind;
  interface?: string;
}

export interface HostInvite {
  code: string;
  webLink: string;
  pasteCode: string;
  link: string;
  maxUses: number | null;
  expiresInHours: number | null;
  createdAt: number;
}

export interface HostInviteOptions {
  maxUses?: number;
  expiresInHours?: number;
}

export interface HostStatus {
  /** Increases with every change; the renderer drops older snapshots. */
  revision: number;
  state: HostState;
  /** The running server's settings, or the last ones used (to prefill the form). */
  config: HostConfig | null;
  port: number | null;
  serverKeyId: string | null;
  fingerprint: string | null;
  addresses: HostAddress[];
  members: number | null;
  maxMembers: number | null;
  hasOwner: boolean | null;
  /** Why the server is not running (state `failed`). */
  error: AppErrorCode | null;
  /** The port that was busy, with PORT_IN_USE. */
  errorPort: number | null;
  /** Why the automatic owner join failed; the server keeps running. */
  joinError: AppErrorCode | null;
  /** The last invite created in this session. */
  invite: HostInvite | null;
  startedAt: number | null;
}

/** start / restart / join / recoverOwnership: the new status, and the welcome when the auto-join worked. */
export interface HostStartResult {
  status: HostStatus;
  welcome: RendererWelcome | null;
}

export interface HostApi {
  status(): Promise<HostStatus>;
  start(config: HostConfig): Promise<HostStartResult>;
  stop(): Promise<HostStatus>;
  restart(): Promise<HostStartResult>;
  /** Runs the automatic owner join again (after a failure, or after switching servers). */
  join(): Promise<HostStartResult>;
  /** "Recuperar posse" (spec §3.3): a new setup code, used right away. */
  recoverOwnership(): Promise<HostStartResult>;
  invite(opts: HostInviteOptions): Promise<HostInvite>;
  logs(): Promise<string[]>;
  /** The sandboxed page has no clipboard permission; the main process copies. */
  copyText(text: string): Promise<void>;
}
