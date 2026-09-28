import { create } from 'zustand';
import type { HostStatus } from '../../../shared/hostTypes.js';

export interface HostView {
  /** null until the first answer from the main process. */
  status: HostStatus | null;
  logs: string[];
}

export type HostAction = { type: 'status'; status: HostStatus } | { type: 'logs'; lines: string[] };

export const initialHost: HostView = { status: null, logs: [] };

/** Pure reducer behind the host store (spec §11.2). Snapshots older than the one shown are dropped. */
export function hostReducer(s: HostView, a: HostAction): HostView {
  switch (a.type) {
    case 'status':
      if (s.status !== null && a.status.revision < s.status.revision) return s;
      return { ...s, status: a.status };
    case 'logs':
      return { ...s, logs: a.lines };
  }
}

export type HostIndicatorKind = 'running' | 'starting' | 'stopping' | 'failed';

/** What the "hosting" pill shows, or null when nothing is hosted. */
export function hostIndicator(status: HostStatus | null): { kind: HostIndicatorKind; name: string } | null {
  if (status === null || status.state === 'stopped' || status.config === null) return null;
  return { kind: status.state, name: status.config.name };
}

/** True when `serverKeyId` is the server this app hosts right now (the server list marks it). */
export function isHostedHere(status: HostStatus | null, serverKeyId: string): boolean {
  return status !== null && status.state !== 'stopped' && status.serverKeyId === serverKeyId;
}

interface HostStore extends HostView {
  dispatch(action: HostAction): void;
}

export const useHostStore = create<HostStore>()((set) => ({
  ...initialHost,
  dispatch: (action) => set((s) => hostReducer(s, action)),
}));
