import { DebouncedNetworkMonitor } from './debouncedNetworkMonitor';
import { StubNetworkMonitor } from './networkMonitor';

describe('DebouncedNetworkMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('inherits initial status from the inner monitor', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    expect(debounced.currentStatus).toBe('connected');

    const inner2 = new StubNetworkMonitor('disconnected');
    const debounced2 = new DebouncedNetworkMonitor(inner2);
    expect(debounced2.currentStatus).toBe('disconnected');
  });

  it('fires offline transitions immediately', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('disconnected');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('disconnected');
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('debounces online transitions by 2s of stable connectivity', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');

    // Not yet fired — still within debounce window.
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');

    jest.advanceTimersByTime(1999);
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('connected');
    expect(debounced.currentStatus).toBe('connected');
  });

  it('cancels pending online fire if offline arrives during the debounce window', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    jest.advanceTimersByTime(1500);
    inner.simulate('disconnected');

    // No online transition ever fired; no offline transition either
    // (we were already at 'disconnected' from the debounced perspective).
    jest.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('resets the debounce timer on repeated online signals', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    jest.advanceTimersByTime(1000);
    // Another online signal before timer fires — should restart the window.
    (inner as any)._currentStatus = 'disconnected';
    inner.simulate('connected');
    jest.advanceTimersByTime(1999);
    expect(handler).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fires online after offline when debounce elapses', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('disconnected');
    expect(handler).toHaveBeenNthCalledWith(1, 'disconnected');

    inner.simulate('connected');
    jest.advanceTimersByTime(2000);
    expect(handler).toHaveBeenNthCalledWith(2, 'connected');
  });

  it('stop() cancels pending online timer and unsubscribes from inner', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    debounced.stop();

    jest.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();

    // Further simulations on inner no longer propagate
    inner.simulate('disconnected');
    inner.simulate('connected');
    jest.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire when inner flips offline before the fire callback runs', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    // Flip inner offline silently (simulate a race: timer is scheduled but
    // inner.currentStatus changes before the callback runs).
    (inner as any)._currentStatus = 'disconnected';

    jest.advanceTimersByTime(2000);
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');
  });
});
