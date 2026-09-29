import { RAILWAY_STEPS, type RailwayPlan, type RailwayProgress, type RailwayStep } from '../../../shared/railwayTypes.js';

export type StepState = 'waiting' | 'running' | 'done' | 'failed';
export type StepStates = Readonly<Record<RailwayStep, StepState>>;

/** The progress list at the start: steps before `from` already finished (a resume starts midway). */
export function initialSteps(from: RailwayStep = 'project'): StepStates {
  const start = RAILWAY_STEPS.indexOf(from);
  return Object.fromEntries(RAILWAY_STEPS.map((step, i) => [step, i < start ? 'done' : 'waiting'])) as Record<RailwayStep, StepState>;
}

/** One progress event from main; a step that starts running means every earlier one finished. */
export function applyProgress(steps: StepStates, p: RailwayProgress): StepStates {
  const index = RAILWAY_STEPS.indexOf(p.step);
  const next = { ...steps };
  if (p.state !== 'failed') for (const step of RAILWAY_STEPS.slice(0, index)) next[step] = 'done';
  next[p.step] = p.state;
  return next;
}

/** The call failed without a "failed" event (e.g. the IPC itself): the running step, or the first unfinished one, failed. */
export function failCurrent(steps: StepStates): StepStates {
  if (RAILWAY_STEPS.some((step) => steps[step] === 'failed')) return steps;
  const current = RAILWAY_STEPS.find((step) => steps[step] === 'running') ?? RAILWAY_STEPS.find((step) => steps[step] !== 'done');
  return current ? { ...steps, [current]: 'failed' } : steps;
}

/** Free and trial workspaces cannot keep a server online all month (research §10): warn before creating. */
export function planWarning(plan: RailwayPlan): 'railway.config.planFree' | 'railway.config.planTrial' | null {
  if (plan === 'FREE') return 'railway.config.planFree';
  if (plan === 'TRIAL') return 'railway.config.planTrial';
  return null;
}

/** A pasted token: surrounding spaces go; one with spaces inside or too long is not a token. */
export function normalizeToken(input: string): string | null {
  const token = input.trim();
  return token.length > 0 && token.length <= 512 && !/\s/.test(token) ? token : null;
}

/** The server name as main accepts it (trimmed, 1–64 characters), or null. */
export function normalizeServerName(input: string): string | null {
  const name = input.trim();
  return name.length > 0 && name.length <= 64 ? name : null;
}
