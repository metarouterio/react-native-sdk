import {
  LifecycleEmitter,
  APPLICATION_INSTALLED,
  APPLICATION_UPDATED,
  APPLICATION_OPENED,
  APPLICATION_BACKGROUNDED,
  UNKNOWN_PREVIOUS,
} from './lifecycleEvents';
import type { AppContext } from '../utils/appContext';
import type Dispatcher from '../dispatcher';
import type { EnrichedEventPayload } from '../types';

describe('LifecycleEmitter', () => {
  const appContext: AppContext = {
    name: 'TestApp',
    version: '1.4.0',
    build: '42',
    namespace: 'com.metarouter.test',
  };

  const setup = () => {
    const dispatcherEnqueue = jest.fn<void, [EnrichedEventPayload]>();
    const dispatcher = { enqueue: dispatcherEnqueue } as unknown as Dispatcher;
    const createTrackEvent = jest.fn(
      (event: string, properties?: Record<string, any>): EnrichedEventPayload =>
        ({
          type: 'track',
          event,
          properties,
          timestamp: '2026-04-28T00:00:00.000Z',
          anonymousId: 'anon-test',
          messageId: 'msg-test',
          writeKey: 'wk-test',
          context: { app: appContext } as any,
        }) as EnrichedEventPayload
    );
    const emitter = new LifecycleEmitter(
      dispatcher,
      createTrackEvent,
      appContext
    );
    return { emitter, dispatcherEnqueue, createTrackEvent };
  };

  it('emits Application Installed with version + build from appContext', () => {
    const { emitter, dispatcherEnqueue, createTrackEvent } = setup();

    emitter.emitInstalled();

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_INSTALLED, {
      version: '1.4.0',
      build: '42',
    });
    expect(dispatcherEnqueue).toHaveBeenCalledTimes(1);
    expect(dispatcherEnqueue.mock.calls[0][0].event).toBe(
      APPLICATION_INSTALLED
    );
  });

  it('emits Application Updated with previous version + build', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitUpdated({ version: '1.3.0', build: '40' });

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_UPDATED, {
      version: '1.4.0',
      build: '42',
      previous_version: '1.3.0',
      previous_build: '40',
    });
  });

  it('emits Application Updated with unknown sentinel for SDK-upgrade case', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitUpdated({
      version: UNKNOWN_PREVIOUS,
      build: UNKNOWN_PREVIOUS,
    });

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_UPDATED, {
      version: '1.4.0',
      build: '42',
      previous_version: 'unknown',
      previous_build: 'unknown',
    });
  });

  it('emits Application Opened with from_background false on cold launch', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitOpened(false);

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: false,
      version: '1.4.0',
      build: '42',
    });
  });

  it('emits Application Opened with from_background true on resume', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitOpened(true);

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: true,
      version: '1.4.0',
      build: '42',
    });
  });

  it('includes url + referring_application when deep link is provided', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitOpened(false, {
      url: 'myapp://product/123',
      referringApplication: 'com.example.referrer',
    });

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: false,
      version: '1.4.0',
      build: '42',
      url: 'myapp://product/123',
      referring_application: 'com.example.referrer',
    });
  });

  it('omits url + referring_application when not provided', () => {
    const { emitter, createTrackEvent } = setup();

    emitter.emitOpened(true, {});

    const props = createTrackEvent.mock.calls[0][1] as Record<string, any>;
    expect(props).not.toHaveProperty('url');
    expect(props).not.toHaveProperty('referring_application');
  });

  it('emits Application Backgrounded with empty properties', () => {
    const { emitter, createTrackEvent, dispatcherEnqueue } = setup();

    emitter.emitBackgrounded();

    expect(createTrackEvent).toHaveBeenCalledWith(APPLICATION_BACKGROUNDED, {});
    expect(dispatcherEnqueue).toHaveBeenCalledTimes(1);
  });
});
