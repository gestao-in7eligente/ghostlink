import { describe, expect, it } from 'vitest';
import {
  applyProgress,
  failCurrent,
  initialSteps,
  normalizeServerName,
  normalizeToken,
  planWarning,
  wizardView,
} from '../../src/renderer/features/railway/railwayModel.js';

describe('Railway progress list', () => {
  it('starts with every step waiting, or with the finished ones done on a resume', () => {
    expect(Object.values(initialSteps())).toEqual(Array(8).fill('waiting'));
    expect(initialSteps('deploy')).toMatchObject({ project: 'done', variables: 'done', deploy: 'waiting', join: 'waiting' });
  });

  it('marks earlier steps done when a later one starts, and keeps a failure where it happened', () => {
    let steps = applyProgress(initialSteps(), { step: 'proxy', state: 'running' });
    expect(steps).toMatchObject({ project: 'done', service: 'done', volume: 'done', proxy: 'running', variables: 'waiting' });
    steps = applyProgress(steps, { step: 'proxy', state: 'failed' });
    expect(steps).toMatchObject({ volume: 'done', proxy: 'failed', variables: 'waiting' });
  });

  it('fails the running step when the call fails without an event, and never a second one', () => {
    const running = applyProgress(initialSteps(), { step: 'deploy', state: 'running' });
    expect(failCurrent(running)).toMatchObject({ variables: 'done', deploy: 'failed', start: 'waiting' });
    expect(failCurrent(initialSteps())).toMatchObject({ project: 'failed', service: 'waiting' });
    const failed = applyProgress(running, { step: 'deploy', state: 'failed' });
    expect(failCurrent(failed)).toBe(failed);
  });
});

describe('Railway form checks', () => {
  it('warns on Free and trial workspaces only', () => {
    expect(planWarning('FREE')).toBe('railway.config.planFree');
    expect(planWarning('TRIAL')).toBe('railway.config.planTrial');
    expect(planWarning('HOBBY')).toBeNull();
    expect(planWarning('PRO')).toBeNull();
    expect(planWarning('UNKNOWN')).toBeNull();
  });

  it('accepts a pasted token with spaces around it, and nothing with spaces inside', () => {
    expect(normalizeToken('  1c2f-abc  \n')).toBe('1c2f-abc');
    expect(normalizeToken('')).toBeNull();
    expect(normalizeToken('two words')).toBeNull();
    expect(normalizeToken('x'.repeat(513))).toBeNull();
  });

  it('takes a server name of 1 to 64 characters', () => {
    expect(normalizeServerName('  Casa  ')).toBe('Casa');
    expect(normalizeServerName('   ')).toBeNull();
    expect(normalizeServerName('a'.repeat(65))).toBeNull();
  });
});

describe('which screen the wizard shows', () => {
  const connected = { connected: true };
  const base = { run: false, loadError: false, account: connected as { connected: boolean } | null, pending: false };

  it('shows a running creation above everything else', () => {
    expect(wizardView({ run: true, loadError: true, account: null, pending: true })).toBe('progress');
  });

  it('falls back to the connect form when the load fails, instead of dead-ending on the error', () => {
    // The saved token no longer works: the user must still reach the form to enter another one.
    expect(wizardView({ ...base, loadError: true, account: null })).toBe('recover');
    expect(wizardView({ ...base, loadError: true })).toBe('recover');
  });

  it('shows loading, then pending/connect/configure by the account state', () => {
    expect(wizardView({ ...base, account: null })).toBe('loading');
    expect(wizardView({ ...base, pending: true })).toBe('pending');
    expect(wizardView({ ...base, account: { connected: false } })).toBe('connect');
    expect(wizardView(base)).toBe('configure');
  });
});
