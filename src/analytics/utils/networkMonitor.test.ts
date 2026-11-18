import { StubNetworkMonitor } from './networkMonitor';

describe('StubNetworkMonitor', () => {
  it('defaults to connected', () => {
    const monitor = new StubNetworkMonitor();
    expect(monitor.currentStatus).toBe('connected');
  });

  it('accepts initial status', () => {
    const monitor = new StubNetworkMonitor('disconnected');
    expect(monitor.currentStatus).toBe('disconnected');
  });

  it('fires handler on status transition', () => {
    const monitor = new StubNetworkMonitor();
    const handler = jest.fn();
    monitor.onStatusChange(handler);

    monitor.simulate('disconnected');
    expect(handler).toHaveBeenCalledWith('disconnected');
    expect(monitor.currentStatus).toBe('disconnected');
  });

  it('does not fire handler when status unchanged', () => {
    const monitor = new StubNetworkMonitor('connected');
    const handler = jest.fn();
    monitor.onStatusChange(handler);

    monitor.simulate('connected');
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires handler on each transition', () => {
    const monitor = new StubNetworkMonitor();
    const handler = jest.fn();
    monitor.onStatusChange(handler);

    monitor.simulate('disconnected');
    monitor.simulate('connected');
    monitor.simulate('disconnected');

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(1, 'disconnected');
    expect(handler).toHaveBeenNthCalledWith(2, 'connected');
    expect(handler).toHaveBeenNthCalledWith(3, 'disconnected');
  });

  it('stop() clears handler', () => {
    const monitor = new StubNetworkMonitor();
    const handler = jest.fn();
    monitor.onStatusChange(handler);

    monitor.stop();
    monitor.simulate('disconnected');
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe clears handler', () => {
    const monitor = new StubNetworkMonitor();
    const handler = jest.fn();
    const unsub = monitor.onStatusChange(handler);

    unsub();
    monitor.simulate('disconnected');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('NetworkMonitor (graceful fallback)', () => {
  it('defaults to connected when native module is unavailable', () => {
    // NetworkMonitor constructor tries require('react-native').NativeModules
    // In test environment, MetaRouterNetworkMonitor will not exist,
    // so it should fall back to always-connected
    const { NetworkMonitor } = require('./networkMonitor');
    const monitor = new NetworkMonitor();
    expect(monitor.currentStatus).toBe('connected');
    monitor.stop();
  });
});

describe('NetworkMonitor wifi tracking', () => {
  const { NativeModules, NativeEventEmitter } = require('react-native');
  const { NetworkMonitor } = require('./networkMonitor');

  let resolveStatus: (raw: unknown) => void;
  let listener: ((body: unknown) => void) | null;

  beforeEach(() => {
    listener = null;
    NativeModules.MetaRouterNetworkMonitor = {
      getCurrentStatus: jest.fn(
        () => new Promise((resolve) => (resolveStatus = resolve))
      ),
    };
    (NativeEventEmitter as jest.Mock).mockImplementation(() => ({
      addListener: (_: string, fn: (body: unknown) => void) => {
        listener = fn;
        return { remove: () => (listener = null) };
      },
    }));
  });

  afterEach(() => {
    NativeModules.MetaRouterNetworkMonitor = undefined;
  });

  // Mirrors the native side: nothing is delivered once the subscription is removed.
  const emit = (body: unknown) => listener?.(body);
  const settle = () => Promise.resolve().then(() => Promise.resolve());

  it('is unknown until the first reading, then takes it', async () => {
    const monitor = new NetworkMonitor();
    expect(monitor.isWifi).toBeNull();

    resolveStatus({ isConnected: true, isWifi: true });
    await settle();
    expect(monitor.isWifi).toBe(true);
    monitor.stop();
  });

  it('follows a wifi -> cellular switch that keeps the device connected', async () => {
    const monitor = new NetworkMonitor();
    const handler = jest.fn();
    monitor.onStatusChange(handler);
    resolveStatus({ isConnected: true, isWifi: true });
    await settle();

    emit({ isConnected: true, isWifi: false });

    expect(monitor.isWifi).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('reads an older native module (bare boolean, no isWifi) as unknown wifi', async () => {
    const monitor = new NetworkMonitor();
    const handler = jest.fn();
    monitor.onStatusChange(handler);

    resolveStatus(false);
    await settle();
    emit({ isConnected: true });

    expect(monitor.isWifi).toBeNull();
    expect(handler.mock.calls).toEqual([['disconnected'], ['connected']]);
    monitor.stop();
  });

  it('is unknown after stop(), even when a reading lands later', async () => {
    const monitor = new NetworkMonitor();
    emit({ isConnected: true, isWifi: true });
    expect(monitor.isWifi).toBe(true);

    monitor.stop();
    resolveStatus({ isConnected: true, isWifi: false });
    await settle();
    emit({ isConnected: true, isWifi: true });

    expect(monitor.isWifi).toBeNull();
  });

  it('awaitIsWifi waits for the first status answer', async () => {
    const monitor = new NetworkMonitor();

    const waiting = monitor.awaitIsWifi(500);
    resolveStatus({ isConnected: true, isWifi: false });

    await expect(waiting).resolves.toBe(false);
    monitor.stop();
  });

  it('an unknown first answer releases waiters at once, without the timeout', async () => {
    const monitor = new NetworkMonitor();
    const onSettled = jest.fn();
    monitor.awaitIsWifi(500).then(onSettled);

    resolveStatus({ isConnected: true, isWifi: null });
    await settle();

    expect(onSettled).toHaveBeenCalledWith(null);
    monitor.stop();
  });

  it('a later unknown reading clears the last-known interface', async () => {
    const monitor = new NetworkMonitor();
    resolveStatus({ isConnected: true, isWifi: true });
    await settle();

    emit({ isConnected: true, isWifi: null });

    expect(monitor.isWifi).toBeNull();
    monitor.stop();
  });

  it('awaitIsWifi times out once, then never waits again', async () => {
    const monitor = new NetworkMonitor();
    const first = monitor.awaitIsWifi(500);
    jest.advanceTimersByTime(500);
    await expect(first).resolves.toBeNull();

    const onSettled = jest.fn();
    monitor.awaitIsWifi(500).then(onSettled);
    await settle();
    expect(onSettled).toHaveBeenCalledWith(null);
    monitor.stop();
  });

  it('awaitIsWifi returns at once without the native module', async () => {
    NativeModules.MetaRouterNetworkMonitor = undefined;
    const monitor = new NetworkMonitor();

    const onSettled = jest.fn();
    monitor.awaitIsWifi(500).then(onSettled);
    await settle();
    expect(onSettled).toHaveBeenCalledWith(null);
  });
});
