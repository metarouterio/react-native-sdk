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

  it('delegates init to initAnalytics', async () => {
    await MetaRouter.analytics.init(opts)
    expect(initAnalytics).toHaveBeenCalledWith(opts)
  })

  it('delegates getClient to getAnalyticsClient', () => {
    MetaRouter.analytics.getClient()
    expect(getAnalyticsClient).toHaveBeenCalled()
  })

  it('delegates reset to resetAnalytics', async () => {
    await MetaRouter.analytics.reset()
    expect(resetAnalytics).toHaveBeenCalled()
  })
})
