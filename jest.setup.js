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
  NativeModules: {},
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