import { setDebugLogging, log, warn, error } from './logger';

describe('MetaRouter Logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setDebugLogging(false); // reset for safety
  });

  it('does not log regular messages when debug is disabled', () => {
    setDebugLogging(false);

    log('should not print');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('always logs warnings regardless of debug setting', () => {
    setDebugLogging(false);

    warn('should always warn');

    expect(console.warn).toHaveBeenCalledWith('[MetaRouter]', 'should always warn');
  });

  it('always logs errors regardless of debug setting', () => {
    setDebugLogging(false);

    error('should always error');

    expect(console.error).toHaveBeenCalledWith('[MetaRouter]', 'should always error');
  });

  it('logs to console.log when debug is enabled', () => {
    setDebugLogging(true);

    log('test log');
    expect(console.log).toHaveBeenCalledWith('[MetaRouter]', 'test log');
  });

  it('logs to console.warn when debug is enabled', () => {
    setDebugLogging(true);

    warn('test warn');
    expect(console.warn).toHaveBeenCalledWith('[MetaRouter]', 'test warn');
  });

  it('supports multiple args', () => {
    setDebugLogging(true);

    log('multiple', { foo: 'bar' });
    expect(console.log).toHaveBeenCalledWith('[MetaRouter]', 'multiple', { foo: 'bar' });
  });
});