import { proxyClient, setRealClient } from './proxyClient'
import type { AnalyticsInterface } from '../types'

describe('proxyClient', () => {
  let mockClient: jest.Mocked<AnalyticsInterface>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      track: jest.fn(),
      identify: jest.fn(),
      group: jest.fn(),
      screen: jest.fn(),
      alias: jest.fn(),
      flush: jest.fn(),
      cleanup: jest.fn(),
    };
  });

  it('queues method calls before client is set', () => {
    proxyClient.track('Event A', { foo: 'bar' });
    proxyClient.identify('user-123', { email: 'test@example.com' });

    expect(mockClient.track).not.toHaveBeenCalled();
    expect(mockClient.identify).not.toHaveBeenCalled();

    setRealClient(mockClient);

    expect(mockClient.track).toHaveBeenCalledWith('Event A', { foo: 'bar' });
    expect(mockClient.identify).toHaveBeenCalledWith('user-123', { email: 'test@example.com' });
  });

  it('forwards method calls immediately after client is set', () => {
    setRealClient(mockClient);

    proxyClient.track('Event B', { foo: 'baz' });
    proxyClient.flush();

    expect(mockClient.track).toHaveBeenCalledWith('Event B', { foo: 'baz' });
    expect(mockClient.flush).toHaveBeenCalled();
  });

  it('does nothing if realClient is reset to null', () => {
    setRealClient(mockClient);
    setRealClient(null);

    proxyClient.track('Event C');
    expect(mockClient.track).not.toHaveBeenCalled();
  });

  it('logs a warning if the pending call queue exceeds 100', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 21; i++) {
      proxyClient.track(`Event ${i}`);
    }
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Proxy queue reached max size (20). Oldest call dropped.')
    );
  });

});
