// for async + await
jest.useFakeTimers({ advanceTimers: true });

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  },
  Platform: {
    OS: 'ios',
    select: jest.fn((obj) => obj.ios || obj.default),
  },
  Linking: {
    getInitialURL: jest.fn(() => Promise.resolve(null)),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  NativeModules: {
    MetaRouterClock: {
      continuousMillis: jest.fn(() => Date.now()),
    },
    MetaRouterQueueStorage: {
      exists: jest.fn(() => Promise.resolve(false)),
      readSnapshot: jest.fn(() => Promise.resolve(null)),
      writeSnapshot: jest.fn(() => Promise.resolve()),
      deleteSnapshot: jest.fn(() => Promise.resolve()),
    },
  },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(),
    removeListener: jest.fn(),
  })),
  Dimensions: {
    get: jest.fn().mockImplementation(() => ({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    })),
  },
  PixelRatio: {
    get: jest.fn(() => 3),
  },
}));

// Only the calls AsyncStorage 2.x and 3.x both have (the peer range spans
// both): a method from one major alone would pass here and throw in an app.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
  },
}));

// Suppress console.warn and console.error in tests to keep output clean
console.warn = jest.fn();
console.error = jest.fn();
