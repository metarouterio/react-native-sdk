module.exports = {
  dependencies: {
    '@segment/analytics-react-native': {},
    '@segment/sovran-react-native': {},
    'react-native-get-random-values': {},
    '@react-native-async-storage/async-storage': {},
  },
  dependency: {
    platforms: {
      ios: {},
      android: {
        sourceDir: './android',
      },
    },
  },
};