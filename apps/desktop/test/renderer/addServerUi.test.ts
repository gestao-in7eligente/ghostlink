import { beforeEach, describe, expect, it } from 'vitest';
import { useAddServerUi } from '../../src/renderer/integration/addServerUi.js';

describe('"Entrar em um servidor" screen state', () => {
  beforeEach(() => {
    useAddServerUi.setState({ join: false });
  });

  it('starts closed', () => {
    expect(useAddServerUi.getState().join).toBe(false);
  });

  it('opens the Join screen', () => {
    useAddServerUi.getState().openJoin();
    expect(useAddServerUi.getState().join).toBe(true);
  });

  it('cancelling Join returns to where the user was', () => {
    useAddServerUi.getState().openJoin();
    useAddServerUi.getState().closeJoin();
    expect(useAddServerUi.getState().join).toBe(false);
  });
});
