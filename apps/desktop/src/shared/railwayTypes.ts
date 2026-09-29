// "Criar um servidor" → "Na nuvem (Railway)" (v0.2, owner-approved design 2026-09-29):
// the app provisions a GhostLink server in the user's own Railway account with a
// pasted API token and joins it as the owner. Shared by main, preload and renderer.

/** The workspace's plan; FREE and TRIAL cannot keep a server running all month (warn). */
export type RailwayPlan = 'FREE' | 'TRIAL' | 'HOBBY' | 'PRO' | 'UNKNOWN';

export interface RailwayWorkspace {
  id: string;
  name: string;
  plan: RailwayPlan;
}

/** Whether a token is stored (never the token itself: it stays encrypted in main). */
export interface RailwayAccount {
  connected: boolean;
  /** The token's workspaces; empty when not connected. */
  workspaces: RailwayWorkspace[];
}

/** Railway's regions (serviceInstanceUpdate.region). Brazil defaults to US East (research §13.7). */
export const RAILWAY_REGIONS = ['us-east4-eqdc4a', 'us-west2', 'europe-west4-drams3a', 'asia-southeast1-eqsg3a'] as const;
export type RailwayRegion = (typeof RAILWAY_REGIONS)[number];
export const RAILWAY_DEFAULT_REGION: RailwayRegion = 'us-east4-eqdc4a';

export interface RailwayCreateRequest {
  workspaceId: string;
  /** The server name (1–64 characters), also the Railway project's name suffix. */
  name: string;
  region: RailwayRegion;
  /** The owner's nickname on the new server. */
  nickname: string;
}

/**
 * The provisioning steps, in order, as the progress list shows them:
 * project → service (image, region, settings) → volume (/data) → proxy (TCP 7700, until active)
 * → variables → deploy (until SUCCESS) → start (the server printed its fingerprint and setup
 * code in the deployment logs) → join (probe, compare the fingerprint, join with the setup code).
 */
export const RAILWAY_STEPS = ['project', 'service', 'volume', 'proxy', 'variables', 'deploy', 'start', 'join'] as const;
export type RailwayStep = (typeof RAILWAY_STEPS)[number];

export interface RailwayProgress {
  step: RailwayStep;
  state: 'running' | 'done' | 'failed';
}

/**
 * A provisioning that did not finish (failed or the app closed midway): the renderer
 * offers "Tentar de novo" (railway.resume) or "Excluir" (railway.discard, deletes the project).
 */
export interface RailwayPending {
  name: string;
  region: RailwayRegion;
  /** The first step that has not completed. */
  step: RailwayStep;
  /** Why it stopped, when it failed in this session. */
  error: string | null;
}
