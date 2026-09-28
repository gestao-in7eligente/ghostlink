import { beforeEach, describe, expect, it } from 'vitest';
import type { HostStatus } from '../../src/shared/hostTypes.js';
import { useHostStore } from '../../src/renderer/features/host/hostStore.js';
import { closeHost, hostFlowView, openHostFlow, openHostPanel, useHostUi } from '../../src/renderer/features/host/hostUi.js';

function setState(state: HostStatus['state'] | null) {
  useHostStore.setState({ status: state === null ? null : ({ revision: 1, state } as HostStatus), logs: [] });
}

beforeEach(() => {
  closeHost();
  setState(null);
});

describe('hostFlowView (one hosted server at a time, spec §9)', () => {
  it('opens the form when nothing runs, the panel while a server is hosted', () => {
    expect(hostFlowView(undefined)).toBe('form');
    expect(hostFlowView('stopped')).toBe('form');
    expect(hostFlowView('failed')).toBe('form'); // prefilled again, e.g. to pick another port
    expect(hostFlowView('starting')).toBe('panel');
    expect(hostFlowView('running')).toBe('panel');
    expect(hostFlowView('stopping')).toBe('panel');
  });
});

describe('host entry points (rail "+", server list, onboarding, server header menu)', () => {
  it('openHostFlow picks the form or the panel from the current status', () => {
    openHostFlow();
    expect(useHostUi.getState().view).toBe('form');
    setState('running');
    openHostFlow();
    expect(useHostUi.getState().view).toBe('panel');
  });

  it('openHostPanel and closeHost', () => {
    openHostPanel();
    expect(useHostUi.getState().view).toBe('panel');
    closeHost();
    expect(useHostUi.getState().view).toBe('closed');
  });
});
