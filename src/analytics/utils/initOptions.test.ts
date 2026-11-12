import { isLoopbackHost, validateInitOptions } from './initOptions';

const base = { writeKey: 'wk', ingestionHost: 'https://example.com' };

const EMPTY_WRITE_KEY = {
  type: 'emptyWriteKey',
  description: 'writeKey must not be empty or whitespace-only',
};
const invalidHost = (raw: string) => ({
  type: 'invalidIngestionHost',
  raw,
  description: `ingestionHost must be an http(s) URL, got "${raw}"`,
});

describe('validateInitOptions', () => {
  let warnSpy: jest.SpyInstance;
  const warnings = () => warnSpy.mock.calls.map((c) => c.join(' '));

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('accepts valid options with no config error and stores defaults', () => {
    const { options, configError } = validateInitOptions(base);
    expect(configError).toBeNull();
    expect(options.maxQueueEvents).toBe(2000);
    expect(options.maxDiskEvents).toBe(10000);
    expect(warnings()).toEqual([]);
  });

  describe('writeKey', () => {
    it('records emptyWriteKey for an empty key instead of throwing', () => {
      expect(
        validateInitOptions({ ...base, writeKey: '' }).configError
      ).toEqual(EMPTY_WRITE_KEY);
    });

    it('rejects a whitespace-only key', () => {
      expect(
        validateInitOptions({ ...base, writeKey: '   ' }).configError
      ).toEqual(EMPTY_WRITE_KEY);
    });

    it('stores the key trimmed', () => {
      const { options, configError } = validateInitOptions({
        ...base,
        writeKey: '  wk  ',
      });
      expect(configError).toBeNull();
      expect(options.writeKey).toBe('wk');
    });
  });

  describe('ingestionHost', () => {
    it.each([
      ['', ''],
      ['not-a-url', 'not-a-url'],
      ['ftp://example.com', 'ftp://example.com'],
      ['https://', 'https://'],
      ['localhost:8080', 'localhost:8080'],
    ])(
      'records invalidIngestionHost for %p with the original string',
      (host, raw) => {
        expect(
          validateInitOptions({ ...base, ingestionHost: host }).configError
        ).toEqual(invalidHost(raw));
      }
    );

    it('keeps the untrimmed original in the error', () => {
      expect(
        validateInitOptions({ ...base, ingestionHost: '  ftp://x/ ' })
          .configError
      ).toEqual(invalidHost('  ftp://x/ '));
    });

    it('checks the scheme case-insensitively', () => {
      expect(
        validateInitOptions({ ...base, ingestionHost: 'HTTPS://example.com' })
          .configError
      ).toBeNull();
    });

    it('trims trailing slashes instead of rejecting them', () => {
      const { options, configError } = validateInitOptions({
        ...base,
        ingestionHost: '  https://example.com//  ',
      });
      expect(configError).toBeNull();
      expect(options.ingestionHost).toBe('https://example.com');
    });

    it.each([
      'https://example.com:8443',
      'https://example.com/base/path',
      'https://[2001:db8::1]:443',
      // Both accepted by Foundation and java.net.URL, so by the native SDKs.
      'https://user:pw@example.com',
      'https://example.com:',
    ])('accepts %p', (host) => {
      expect(
        validateInitOptions({ ...base, ingestionHost: host }).configError
      ).toBeNull();
    });

    it('warns on cleartext http to a remote host but accepts it', () => {
      const { configError } = validateInitOptions({
        ...base,
        ingestionHost: 'http://collector.example.com',
      });
      expect(configError).toBeNull();
      expect(warnings()).toEqual([
        expect.stringContaining(
          'ingestionHost http://collector.example.com is cleartext http — use https outside local development.'
        ),
      ]);
    });

    it.each([
      'http://localhost:8080',
      'http://127.0.0.1:9999',
      'http://[::1]:9999',
      'http://user:pw@localhost:8080',
    ])('does not warn for loopback %p', (host) => {
      validateInitOptions({ ...base, ingestionHost: host });
      expect(warnings()).toEqual([]);
    });
  });

  it('first error wins: writeKey before host', () => {
    expect(
      validateInitOptions({ writeKey: '', ingestionHost: 'ftp://x' })
        .configError
    ).toEqual(EMPTY_WRITE_KEY);
  });

  describe('numeric bounds clamp with a warning', () => {
    it('flushIntervalSeconds 0 → 1', () => {
      const { options, configError } = validateInitOptions({
        ...base,
        flushIntervalSeconds: 0,
      });
      expect(configError).toBeNull();
      expect(options.flushIntervalSeconds).toBe(1);
      expect(warnings()).toEqual([
        expect.stringContaining('flushIntervalSeconds (0) clamped to 1'),
      ]);
    });

    it('maxQueueEvents -5 → 1', () => {
      const { options } = validateInitOptions({ ...base, maxQueueEvents: -5 });
      expect(options.maxQueueEvents).toBe(1);
      expect(warnings()).toEqual([
        expect.stringContaining('maxQueueEvents (-5) clamped to 1'),
      ]);
    });

    it('maxDiskEvents -1 → 0', () => {
      const { options, configError } = validateInitOptions({
        ...base,
        maxDiskEvents: -1,
      });
      expect(configError).toBeNull();
      expect(options.maxDiskEvents).toBe(0);
      expect(warnings()).toEqual([
        expect.stringContaining(
          'maxDiskEvents (-1) clamped to 0 — use 0 to disable disk persistence'
        ),
      ]);
    });

    it('sessionTimeoutMinutes 0 → 1', () => {
      const { options, configError } = validateInitOptions({
        ...base,
        sessionTimeoutMinutes: 0,
      });
      expect(configError).toBeNull();
      expect(options.sessionTimeoutMinutes).toBe(1);
      expect(warnings()).toEqual([
        expect.stringContaining('sessionTimeoutMinutes (0) clamped to 1'),
      ]);
    });

    it('leaves sessionTimeoutMinutes unset when not given', () => {
      expect(validateInitOptions(base).options.sessionTimeoutMinutes).toBe(
        undefined
      );
    });
  });

  it.each([
    'flushIntervalSeconds',
    'maxQueueEvents',
    'maxDiskEvents',
    'sessionTimeoutMinutes',
  ] as const)('treats a non-finite %s as unset, with a warning', (field) => {
    const { options, configError } = validateInitOptions({
      ...base,
      [field]: NaN,
    });
    expect(configError).toBeNull();
    expect(Number.isNaN(options[field])).toBe(false);
    expect(warnings()).toEqual([
      expect.stringContaining(
        `${field} (NaN) is not a finite number — using the default`
      ),
    ]);
  });

  describe('maxDiskEvents below maxQueueEvents', () => {
    it('warns when 0 < disk < queue', () => {
      validateInitOptions({
        ...base,
        maxQueueEvents: 2000,
        maxDiskEvents: 500,
      });
      expect(warnings()).toEqual([
        expect.stringContaining(
          'maxDiskEvents (500) is less than maxQueueEvents (2000) — memory can hold more events than disk can preserve; events may be dropped during background flush'
        ),
      ]);
    });

    it.each([
      [500, 500],
      [2000, 10000],
      [2000, 0],
    ])('does not warn for queue=%p disk=%p', (q, d) => {
      validateInitOptions({ ...base, maxQueueEvents: q, maxDiskEvents: d });
      expect(warnings()).toEqual([]);
    });
  });

  it('logs nothing when logWarnings is false', () => {
    validateInitOptions(
      { ...base, ingestionHost: 'http://x.example.com', maxDiskEvents: -1 },
      { logWarnings: false }
    );
    expect(warnings()).toEqual([]);
  });
});

describe('ConfigError.description', () => {
  it('matches the iOS and Android wording byte for byte', () => {
    expect(
      validateInitOptions({ ...base, writeKey: '' }).configError?.description
    ).toBe('writeKey must not be empty or whitespace-only');
    expect(
      validateInitOptions({ ...base, ingestionHost: 'nope' }).configError
        ?.description
    ).toBe('ingestionHost must be an http(s) URL, got "nope"');
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])('%p is loopback', (h) =>
    expect(isLoopbackHost(h)).toBe(true)
  );
  it.each(['10.0.2.2', '127.0.0.2', 'app.localhost', 'example.com'])(
    '%p is not loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false)
  );
});
