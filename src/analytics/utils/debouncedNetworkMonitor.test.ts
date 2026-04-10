import { StubNetworkMonitor } from './networkMonitor';
import { DebouncedNetworkMonitor } from './debouncedNetworkMonitor';

beforeEach(() => {
  jest.clearAllTimers();
});

describe('DebouncedNetworkMonitor', () => {
  it('currentStatus reflects initial inner status (connected)', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    expect(debounced.currentStatus).toBe('connected');
  });

  it('currentStatus reflects initial inner status (disconnected)', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('offline transition fires immediately', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('disconnected');

    expect(handler).toHaveBeenCalledWith('disconnected');
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('online transition is debounced — does not fire before 2s', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');

    // Should not fire immediately
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');

    // Should not fire at 1999ms
    jest.advanceTimersByTime(1999);
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('online transition fires after 2s debounce', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');

    jest.advanceTimersByTime(2000);
    expect(handler).toHaveBeenCalledWith('connected');
    expect(debounced.currentStatus).toBe('connected');
  });

  it('rapid flapping produces single online action', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    // offline -> online -> offline -> online -> offline -> online
    inner.simulate('disconnected');
    inner.simulate('connected');
    inner.simulate('disconnected');
    inner.simulate('connected');
    inner.simulate('disconnected');
    inner.simulate('connected');

    // Only the first offline should have fired immediately
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('disconnected');

    handler.mockClear();

    // After debounce, exactly one online
    jest.advanceTimersByTime(2000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('connected');
  });

  it('debounce timer cancelled when device goes back offline', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    // Come online — starts debounce
    inner.simulate('connected');
    jest.advanceTimersByTime(1500);

    // Go offline before debounce fires
    inner.simulate('disconnected');
    expect(handler).not.toHaveBeenCalled(); // was already disconnected, no transition

    // Advance past original debounce window — should NOT fire online
    jest.advanceTimersByTime(2000);
    expect(handler).not.toHaveBeenCalled();
    expect(debounced.currentStatus).toBe('disconnected');
  });

  it('stop() cancels pending debounce and cleans up', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    debounced.stop();

    jest.advanceTimersByTime(2000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('clean sequential transitions work independently', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    // First: go offline
    inner.simulate('disconnected');
    expect(handler).toHaveBeenCalledWith('disconnected');

    // Then: come back online, wait for debounce
    inner.simulate('connected');
    jest.advanceTimersByTime(2000);
    expect(handler).toHaveBeenCalledWith('connected');

    // Go offline again
    inner.simulate('disconnected');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenLastCalledWith('disconnected');
  });

  it('second online signal restarts debounce window', () => {
    const inner = new StubNetworkMonitor('disconnected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    debounced.onStatusChange(handler);

    inner.simulate('connected');
    jest.advanceTimersByTime(1500);

    // Simulate a second connected event (e.g. wifi -> cellular handoff)
    // StubNetworkMonitor won't fire if status is same, so we go through disconnected briefly
    inner.simulate('disconnected');
    inner.simulate('connected');

    // 1.5s from second signal — still within restarted window
    jest.advanceTimersByTime(1500);
    expect(handler).not.toHaveBeenCalledWith('connected');

    // 0.5s more — should now fire
    jest.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledWith('connected');
  });

  it('unsubscribe stops handler from being called', () => {
    const inner = new StubNetworkMonitor('connected');
    const debounced = new DebouncedNetworkMonitor(inner);
    const handler = jest.fn();
    const unsub = debounced.onStatusChange(handler);

    unsub();
    inner.simulate('disconnected');
    expect(handler).not.toHaveBeenCalled();
  });
});
