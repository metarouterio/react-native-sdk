import {
  LifecycleEmitter,
  APPLICATION_INSTALLED,
  APPLICATION_UPDATED,
  APPLICATION_OPENED,
  APPLICATION_BACKGROUNDED,
  UNKNOWN_PREVIOUS,
} from './lifecycleEvents';

describe('LifecycleEmitter', () => {
  const versionInfo = { version: '1.4.0', build: '42' };

  it('emits Application Installed with version + build', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitInstalled(versionInfo);

    expect(track).toHaveBeenCalledWith(APPLICATION_INSTALLED, {
      version: '1.4.0',
      build: '42',
    });
  });

  it('emits Application Updated with previous version + build', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitUpdated(versionInfo, { version: '1.3.0', build: '40' });

    expect(track).toHaveBeenCalledWith(APPLICATION_UPDATED, {
      version: '1.4.0',
      build: '42',
      previous_version: '1.3.0',
      previous_build: '40',
    });
  });

  it('emits Application Updated with unknown sentinel for SDK-upgrade case', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitUpdated(versionInfo, {
      version: UNKNOWN_PREVIOUS,
      build: UNKNOWN_PREVIOUS,
    });

    expect(track).toHaveBeenCalledWith(APPLICATION_UPDATED, {
      version: '1.4.0',
      build: '42',
      previous_version: 'unknown',
      previous_build: 'unknown',
    });
  });

  it('emits Application Opened with from_background false on cold launch', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitOpened(versionInfo, false);

    expect(track).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: false,
      version: '1.4.0',
      build: '42',
    });
  });

  it('emits Application Opened with from_background true on resume', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitOpened(versionInfo, true);

    expect(track).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: true,
      version: '1.4.0',
      build: '42',
    });
  });

  it('includes url + referring_application when deep link is provided', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitOpened(versionInfo, false, {
      url: 'myapp://product/123',
      referringApplication: 'com.example.referrer',
    });

    expect(track).toHaveBeenCalledWith(APPLICATION_OPENED, {
      from_background: false,
      version: '1.4.0',
      build: '42',
      url: 'myapp://product/123',
      referring_application: 'com.example.referrer',
    });
  });

  it('omits url + referring_application when not provided', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitOpened(versionInfo, true, {});

    const props = track.mock.calls[0][1];
    expect(props).not.toHaveProperty('url');
    expect(props).not.toHaveProperty('referring_application');
  });

  it('emits Application Backgrounded with empty properties', () => {
    const track = jest.fn();
    const emitter = new LifecycleEmitter(track, true);

    emitter.emitBackgrounded();

    expect(track).toHaveBeenCalledWith(APPLICATION_BACKGROUNDED, {});
  });

  describe('disabled emitter', () => {
    it('does not call track for any event when disabled', () => {
      const track = jest.fn();
      const emitter = new LifecycleEmitter(track, false);

      emitter.emitInstalled(versionInfo);
      emitter.emitUpdated(versionInfo, { version: '1.0.0', build: '1' });
      emitter.emitOpened(versionInfo, false);
      emitter.emitOpened(versionInfo, true);
      emitter.emitBackgrounded();

      expect(track).not.toHaveBeenCalled();
    });

    it('isEnabled reflects the constructor flag', () => {
      expect(new LifecycleEmitter(jest.fn(), true).isEnabled()).toBe(true);
      expect(new LifecycleEmitter(jest.fn(), false).isEnabled()).toBe(false);
    });
  });
});
