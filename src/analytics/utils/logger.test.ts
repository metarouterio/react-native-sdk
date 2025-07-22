import { setDebugLogging, log, warn } from './logger';

describe('MetaRouter Logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setDebugLogging(false); // reset for safety
  });

  it('does not log when debug is disabled', () => {
    setDebugLogging(false);

    log('should not print');
    warn('should not warn');

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
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