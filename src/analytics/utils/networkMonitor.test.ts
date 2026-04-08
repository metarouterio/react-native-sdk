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
