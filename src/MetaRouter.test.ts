import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MetaRouter } from './MetaRouter';
import { createClient, mockClient } from './__mocks__/@segment/analytics-react-native';

jest.mock('@segment/analytics-react-native');


const options = {
  writeKey: 'test-key',
  ingestionEndpoint: 'https://example.com',
};

beforeEach(async () => {
  jest.clearAllMocks();
  await MetaRouter.reset();
});

describe('MetaRouter', () => {
  it('throws if required config is missing', async () => {
    await expect(MetaRouter.init({ writeKey: '', ingestionEndpoint: '' }))
      .rejects
      .toThrow('writeKey is required');
  });

  it('initializes once and calls createClient + init', async () => {
    const client = await MetaRouter.init(options);

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ writeKey: options.writeKey })
    );
    expect(mockClient.init).toHaveBeenCalled();
    expect(client).toBeDefined();
  });

  it('does not reinitialize on subsequent init calls', async () => {
    await MetaRouter.init(options);
    await MetaRouter.init({ ...options, writeKey: 'another-key' });

    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('forwards all analytics method calls after init', async () => {
    const client = await MetaRouter.init(options);

    client.track('Test Event', { a: 1 });
    expect(mockClient.track).toHaveBeenCalledWith('Test Event', { a: 1 });

    client.identify('user_123', { name: 'Jane' });
    expect(mockClient.identify).toHaveBeenCalledWith('user_123', { name: 'Jane' });

    client.group('group_abc', { type: 'org' });
    expect(mockClient.group).toHaveBeenCalledWith('group_abc', { type: 'org' });

    client.screen('Home');
    expect(mockClient.screen).toHaveBeenCalledWith('Home', undefined);

    client.alias('new-id');
    expect(mockClient.alias).toHaveBeenCalledWith('new-id');

    client.flush();
    expect(mockClient.flush).toHaveBeenCalled();

    client.cleanup();
    expect(mockClient.cleanup).toHaveBeenCalled();
  });

  it('returns a usable proxy client before init', () => {
    const client = MetaRouter.getClient();

    // These should not throw, but will be queued internally
    expect(() => client.track('Event Before Init')).not.toThrow();
    expect(() => client.flush()).not.toThrow();
  });

  it('flushes queued proxy calls after init', async () => {
    const client = MetaRouter.getClient();
    client.track('queued-event', { foo: 'bar' });

    const realClient = await MetaRouter.init(options);
    expect(mockClient.track).toHaveBeenCalledWith('queued-event', { foo: 'bar' });
  });

  it('create() triggers init and returns usable client', async () => {
    const client = MetaRouter.create(options);
    expect(() => client.track('created-client-event')).not.toThrow();

    // Let init resolve
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockClient.track).toHaveBeenCalledWith('created-client-event', undefined);
  });

  it('reset clears the internal state', async () => {
    const client = await MetaRouter.init(options);
    client.track('before-reset');
    expect(mockClient.track).toHaveBeenCalledWith('before-reset', undefined);

    await MetaRouter.reset();

    const newClient = MetaRouter.getClient();
    expect(() => newClient.track('after-reset')).not.toThrow(); // Should queue, not throw
  });
});