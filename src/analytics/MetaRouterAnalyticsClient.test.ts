import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient'
import type { InitOptions } from './types'
import { AppState } from 'react-native'

const mockAddEventListener = jest.fn()
jest.spyOn(AppState, 'addEventListener').mockImplementation(mockAddEventListener)


global.fetch = jest.fn(() => Promise.resolve({ ok: true })) as any


jest.mock('./utils/anonymousId', () => ({
  getAnonymousId: jest.fn(() => Promise.resolve('anon-123')),
}));

const opts: InitOptions = {
  ingestionEndpoint: 'https://example.com',
  writeKey: 'test_write_key',
  flushInterval: 5000,
}

describe('MetaRouterAnalyticsClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('adds a track event to the queue', async () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Product Viewed', { sku: '123' })

    expect(client['queue']).toHaveLength(1)
    expect(client['queue'][0]).toMatchObject({
      type: 'track',
      event: 'Product Viewed',
      properties: { sku: '123' },
    })
  })

  it('adds identify event with userId', () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.identify('user-123', { plan: 'pro' })

    expect(client['queue'][0]).toMatchObject({
      type: 'identify',
      userId: 'user-123',
      traits: { plan: 'pro' },
    })
  })

  it('flushes queued events to the endpoint', async () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Test Event')
    
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 10))
    await client.flush()

    expect(fetch).toHaveBeenCalledWith(
      `${opts.ingestionEndpoint}/v1/batch`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('Test Event'),
      })
    )
  })

  it('clears the queue after successful flush', async () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Flush Test')
    expect(client['queue']).toHaveLength(1)

    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 10))
    await client.flush()
    expect(client['queue']).toHaveLength(0)
  })

  it('re-queues events on flush failure', async () => {
    global.fetch = jest.fn(() => Promise.reject('Network error')) as any

    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Event Retry')
    await client.flush()

    expect(client['queue']).toHaveLength(1)
  })

  it('cleans up interval and queue', () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Will be removed')
    client.cleanup()

    expect(client['queue']).toHaveLength(0)
    expect(client['flushTimer']).toBeNull()
  })

  it('adds userId to subsequent events after identify()', () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.identify('user-999')
    client.track('Event with identity')
  
    expect(client['queue'][1].userId).toBe('user-999')
  })

  it('adds groupId to subsequent events after group()', () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.group('group-123')
    client.track('Event with group')
  
    expect(client['queue'][1].groupId).toBe('group-123')
  })

  it('flushes when app goes to background', async () => {
    const client = new MetaRouterAnalyticsClient(opts)
    client.track('Lifecycle Event')
    
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 10))
    
    expect(mockAddEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    const handler = mockAddEventListener.mock.calls[0][1]
    handler('background') // simulate transition
  
    await new Promise(resolve => setTimeout(resolve, 10)) // allow flush to run
    expect(fetch).toHaveBeenCalled()
  })

})
