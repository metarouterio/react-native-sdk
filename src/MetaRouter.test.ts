import { MetaRouter } from './MetaRouter'
import type { InitOptions } from './analytics/types'

jest.mock('./analytics/init', () => {
  const actual = jest.requireActual('./analytics/init')
  return {
    ...actual,
    initAnalytics: jest.fn(actual.initAnalytics),
    getAnalyticsClient: jest.fn(actual.getAnalyticsClient),
    resetAnalytics: jest.fn(actual.resetAnalytics),
  }
})

import { initAnalytics, getAnalyticsClient, resetAnalytics } from './analytics/init'

const opts: InitOptions = {
  ingestionEndpoint: 'https://example.com',
  writeKey: 'test_write_key',
  flushInterval: 5000,
}

describe('MetaRouter.analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })


  it('delegates getClient to getAnalyticsClient', () => {
    MetaRouter.analytics.getClient()
    expect(getAnalyticsClient).toHaveBeenCalled()
  })

  it('delegates reset to resetAnalytics', async () => {
    await MetaRouter.analytics.reset()
    expect(resetAnalytics).toHaveBeenCalled()
  })

  it('calls analytics.init and returns a client', async () => {
    const client = await MetaRouter.analytics.init(opts);
    expect(initAnalytics).toHaveBeenCalledWith(opts);
    expect(client).toHaveProperty('track');
  });

  it('calls analytics.getClient and returns a client', () => {
    const client = MetaRouter.analytics.getClient();
    expect(getAnalyticsClient).toHaveBeenCalled();
    expect(client).toHaveProperty('track');
  });

  it('calls analytics.reset and resolves', async () => {
    await expect(MetaRouter.analytics.reset()).resolves.toBeUndefined();
    expect(resetAnalytics).toHaveBeenCalled();
  });

  it('exposes the expected analytics API shape', () => {
    expect(MetaRouter.analytics).toHaveProperty('init');
    expect(MetaRouter.analytics).toHaveProperty('getClient');
    expect(MetaRouter.analytics).toHaveProperty('reset');
  });

})
