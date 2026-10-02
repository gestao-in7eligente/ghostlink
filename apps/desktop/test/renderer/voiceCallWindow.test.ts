import { describe, expect, it, vi } from 'vitest';
import { CallWindowLifecycle } from '../../src/renderer/features/voice/callWindowModel.js';

describe('the mini window opens and closes with my share', () => {
  function setup(opens = true) {
    const ops = { open: vi.fn(() => opens), close: vi.fn() };
    return { ops, lifecycle: new CallWindowLifecycle(ops) };
  }

  it('opens when my share starts and closes when it ends', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(false);
    expect(ops.open).not.toHaveBeenCalled();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(true);
    lifecycle.update(true); // nothing new
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    expect(ops.close).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(false);
  });

  it('✕ closes it while the share goes on; the next share opens it again', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.dismiss();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    expect(ops.close).toHaveBeenCalledOnce(); // already closed
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('closed by other means (Alt+F4) counts as ✕', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.gone();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.gone(); // once
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('a refused window is not asked for again during the same share', () => {
    const { ops, lifecycle } = setup(false);
    lifecycle.update(true);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(false);
    lifecycle.update(false);
    expect(ops.close).not.toHaveBeenCalled();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('closes for good when the page goes', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.dispose();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.update(false);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
  });
});
