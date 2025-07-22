import { getTimeZone } from './timezone';

describe('getTimeZone', () => {
  const originalIntl = Intl;

  afterEach(() => {
    // Restore original Intl after mocking
    global.Intl = originalIntl;
  });

  it('returns the correct timezone from Intl API', () => {
    const mockResolvedOptions = jest.fn().mockReturnValue({ timeZone: 'America/Denver' });

    global.Intl = {
      DateTimeFormat: jest.fn().mockImplementation(() => ({
        resolvedOptions: mockResolvedOptions,
      })),
    } as any;

    expect(getTimeZone()).toBe('America/Denver');
    expect(mockResolvedOptions).toHaveBeenCalled();
  });

  it('returns "UTC" if Intl API throws', () => {
    global.Intl = {
      DateTimeFormat: jest.fn(() => {
        throw new Error('Intl error');
      }),
    } as any;

    expect(getTimeZone()).toBe('UTC');
  });
});