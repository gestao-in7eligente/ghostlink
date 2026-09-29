import { beforeEach, describe, expect, it } from 'vitest';
import { openAddServer, useAddServerUi } from '../../src/renderer/integration/addServerUi.js';

describe('rail "+" chooser state', () => {
  beforeEach(() => {
    useAddServerUi.setState({ chooser: false, join: false });
  });

  it('starts closed', () => {
    const s = useAddServerUi.getState();
    expect(s.chooser).toBe(false);
    expect(s.join).toBe(false);
  });

  it('"+" opens the chooser', () => {
    openAddServer();
    expect(useAddServerUi.getState().chooser).toBe(true);
  });

  it('"Entrar em um servidor" closes the chooser and opens the Join screen', () => {
    openAddServer();
    useAddServerUi.getState().openJoin();
    expect(useAddServerUi.getState()).toMatchObject({ chooser: false, join: true });
  });

  it('closing the chooser does not open the Join screen', () => {
    openAddServer();
    useAddServerUi.getState().closeChooser();
    expect(useAddServerUi.getState()).toMatchObject({ chooser: false, join: false });
  });

  it('cancelling Join returns to where the user was', () => {
    useAddServerUi.getState().openJoin();
    useAddServerUi.getState().closeJoin();
    expect(useAddServerUi.getState().join).toBe(false);
  });
});
